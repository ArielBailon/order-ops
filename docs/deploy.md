# Deploying OrderOps to AWS

This runbook puts the production compose (see "Production compose" in the README) on one EC2
instance at `https://api.arielbailon.dev`: HTTPS from Caddy, logs in CloudWatch, a nightly
database backup in S3, and no AWS access keys on the server. Releases are automatic from
`master` (see "Continuous deployment").

Why one instance and not ECS Fargate + RDS + ALB: it is a demo, and the managed stack costs
several times more. It remains the documented next step to scale.

## Decisions

| Choice | Value | Why |
| --- | --- | --- |
| Region | `us-east-1` | The Bedrock model ids in `apps/orderops-agent/src/models/providers.ts` are `us.` inference profiles, and it is the cheapest region. Every command below passes `--region` explicitly, because a CLI default of another region (for example `sa-east-1`) would silently create resources elsewhere. |
| Instance | `t3.small` (x86_64), 30 GB gp3, encrypted | 2 vCPU and 2 GB RAM run the stack; the 2 GB swap file from `deploy/bootstrap.sh` covers image builds. x86 means the instance builds the same images your machine does. `t4g.small` (ARM) is about 20% cheaper; switch by changing `ARCH` and `TYPE` in step 6 and rebuilding. |
| Access | AWS Systems Manager Session Manager | No SSH key, no port 22. It is also what the deploy workflow uses. |
| Credentials | Instance IAM role only | No access key exists on the host or in any container. |

## What it costs (approximate, `us-east-1`, check current pricing)

| Item | Per month |
| --- | --- |
| EC2 `t3.small` on demand | about 15 USD |
| EBS 30 GB gp3 | about 2.50 USD |
| Public IPv4 (the Elastic IP; charged even when attached) | about 3.65 USD |
| CloudWatch Logs (30-day retention, demo traffic) | under 1 USD |
| S3 backups (14-day expiry, small dumps) | under 0.10 USD |
| SSM Session Manager, IAM, Budgets (first two budgets) | free |
| Model API calls (Anthropic, OpenAI) | not AWS: depends on traffic, see the README cost report |

Total about 21 USD per month before model calls. Section 9 sets a budget alert, and the
teardown at the end removes everything.

## Who runs what

- You create the Cloudflare DNS record (section 5) in the Cloudflare dashboard.
- You type the production secrets on the server (section 8). They never go into this repo, the
  AWS CLI history or the instance user data.
- The CLI commands below can be run by you or, with your explicit yes for each numbered group,
  by the assistant from your terminal. Read-only `describe`/`get`/`list` commands need no
  approval. Every group that creates something says what it creates and costs.

## 0. Setup

Run the commands in a bash shell (Git Bash on Windows works). The AWS CLI v2 and the Session
Manager plugin (`session-manager-plugin`) must be installed on your machine.

```bash
export MSYS_NO_PATHCONV=1            # Git Bash on Windows: stop it rewriting /orderops/prod
REGION=us-east-1
aws sts get-caller-identity --region "$REGION"      # confirm the account you mean to use
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
BUCKET="orderops-backups-$ACCOUNT"
LOG_GROUP=/orderops/prod
ROLE=orderops-ec2
DOMAIN=api.arielbailon.dev
WORK=$(mktemp -d)                   # scratch folder for the JSON files below
command -v cygpath >/dev/null && WORK=$(cygpath -m "$WORK")   # Git Bash: the Windows AWS CLI needs a Windows path
```

The CLI user needs permission to create the resources below. If a command is denied, stop and
add only that permission (or use the console for that step); do not widen the user to
administrator.

### Recover the variables (new terminal, after step 6)

Verify, Restore, "Check the last backup" and Teardown use `$INSTANCE`, `$SG` and `$ALLOC`, which
only exist in the shell that ran the earlier steps. In a new terminal, repeat the block above
(through `DOMAIN`), then look the rest up:

```bash
INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values=orderops-prod Name=instance-state-name,Values=pending,running,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
SG=$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values=orderops-web \
  --query 'SecurityGroups[0].GroupId' --output text)
ALLOC=$(aws ec2 describe-addresses --region "$REGION" --filters Name=instance-id,Values="$INSTANCE" \
  --query 'Addresses[0].AllocationId' --output text)
echo "$INSTANCE $SG $ALLOC"     # all three must be real ids: stop if any prints None or is empty
```

Look `ALLOC` up before terminating the instance in Teardown, because the association disappears
with it. On the instance, each new SSM session also needs `cd ~/order-ops` and the `dc=` line
from step 8.

## 1. Backup bucket (creates an S3 bucket, pennies)

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --region "$REGION" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" \
  --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-backups","Status":"Enabled","Filter":{"Prefix":"orderops/"},"Expiration":{"Days":14}}]}'
```

## 2. Log group (creates a CloudWatch log group)

Docker's `awslogs` driver does not create the group in this setup (`awslogs-create-group` is
`false`), so create it with a retention that caps the cost:

```bash
aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION"
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30 --region "$REGION"
```

## 3. Instance role (creates an IAM role and instance profile, free)

The role grants exactly what the host needs: Session Manager access, writing to this one log
group, uploading to the backup prefix of this one bucket, and invoking the two Bedrock models the
app is configured with.

```bash
cat > $WORK/orderops-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

# Model ids come from MODEL_IDS.bedrock in apps/orderops-agent/src/models/providers.ts.
HAIKU_PROFILE=us.anthropic.claude-haiku-4-5-20251001-v1:0
SONNET_PROFILE=us.anthropic.claude-sonnet-4-5-20250929-v1:0
cat > $WORK/orderops-policy.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"Logs","Effect":"Allow",
  "Action":["logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":"arn:aws:logs:$REGION:$ACCOUNT:log-group:$LOG_GROUP:log-stream:*"},
 {"Sid":"BackupUpload","Effect":"Allow","Action":"s3:PutObject",
  "Resource":"arn:aws:s3:::$BUCKET/orderops/*"},
 {"Sid":"BedrockInvoke","Effect":"Allow",
  "Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
  "Resource":[
   "arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$HAIKU_PROFILE",
   "arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$SONNET_PROFILE",
   "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
   "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0"]}
]}
EOF

aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://$WORK/orderops-trust.json
aws iam put-role-policy --role-name "$ROLE" --policy-name orderops-host --policy-document file://$WORK/orderops-policy.json
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name "$ROLE"
aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
```

The Bedrock statement is **not verified end to end**: the account's Bedrock access is suspended
(AWS Support case open), so a real model call from the instance cannot be tested yet. The
foundation-model ARNs use a wildcard region because a `us.` inference profile can route to
several US regions. Once access is restored, test with the steps in "Bedrock check" below.

## 4. Security group (creates a security group, free)

Only 80 and 443 are open to the internet. 80 is needed for the certificate challenge and the
redirect. There is no SSH rule.

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region "$REGION")
SG=$(aws ec2 create-security-group --group-name orderops-web --vpc-id "$VPC" \
  --description "OrderOps web 80/443" --query GroupId --output text --region "$REGION")
for port in 80 443; do
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$port" \
    --cidr 0.0.0.0/0 --region "$REGION"
done
```

## 5. Elastic IP and DNS (allocates an Elastic IP, about 3.65 USD per month)

Allocate the address first, then point the DNS record at it **before** the first `up`: Caddy
requests the certificate when it starts, and failing early can run into Let's Encrypt rate limits.

```bash
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text --region "$REGION")
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' \
  --output text --region "$REGION")
echo "$EIP"
```

In the Cloudflare dashboard for `arielbailon.dev` (DNS, Records, Add record):

- Type `A`, Name `api`, IPv4 address = the value printed above.
- Proxy status **DNS only** (grey cloud). The orange proxy would break Caddy's certificate
  challenge and add buffering to the SSE streams.

Check from your machine: `nslookup "$DOMAIN"` returns the Elastic IP.

## 6. Launch the instance (creates the EC2 instance and a volume, about 17.50 USD per month)

```bash
TYPE=t3.small
ARCH=x86_64      # use arm64 with TYPE=t4g.small for ARM
AMI=$(aws ssm get-parameter --region "$REGION" \
  --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-$ARCH" \
  --query Parameter.Value --output text)

INSTANCE=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" --instance-type "$TYPE" \
  --iam-instance-profile Name="$ROLE" --security-group-ids "$SG" \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true}' \
  --user-data file://deploy/bootstrap.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=orderops-prod}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-status-ok --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 associate-address --instance-id "$INSTANCE" --allocation-id "$ALLOC" --region "$REGION"
```

Notes: there is no key pair (access is Session Manager). IMDSv2 is required. The metadata hop
limit is 1, so only the host (Docker's `awslogs` driver, `deploy/deploy.sh`, the backup timer)
can read the instance role's credentials; a container cannot, which limits what an SSRF or a
compromised container can reach. The gateway's Bedrock client runs in a container and needs a
hop limit of 2, which the "Bedrock check" step turns on once Bedrock is in use.
`deploy/bootstrap.sh` runs as user data (root, once)
and installs Docker, git and a checksum-verified Compose plugin and adds the swap file. Allow a
couple of minutes after the status check, then confirm the instance is online in SSM:

```bash
aws ssm describe-instance-information --region "$REGION" \
  --query "InstanceInformationList[?InstanceId=='$INSTANCE'].PingStatus" --output text   # Online
```

## 7. Connect

```bash
aws ssm start-session --target "$INSTANCE" --region "$REGION"
sudo -iu ec2-user          # inside the session: work as ec2-user from here on
docker --version && docker compose version     # both come from the bootstrap
```

## 8. First deploy (on the instance, as `ec2-user`)

```bash
git clone https://github.com/ArielBailon/order-ops.git
cd order-ops
```

If the repository is private, clone with a read-only fine-grained token that you paste at the
prompt; never put the token in a file, a URL you save or the shell history.

Create the secrets file by typing the values here (not from your laptop):

```bash
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Fill in `API_DOMAIN=api.arielbailon.dev`, a URL-safe `POSTGRES_PASSWORD` (`openssl rand -hex 24`),
`JWT_SECRET` (32+ characters), `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Leave `AWS_REGION` empty
until Bedrock access is restored. `LOG_REGION` and `LOG_GROUP` already default to this runbook.
To send Langfuse spans, also fill in `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from your
Langfuse project (and `LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` for a US project); leave
both empty to keep it off. Spans are metadata only (no message text, tool data or tokens), so
no customer content reaches Langfuse. The keys are secrets: type them here like the others.

Start everything with the CloudWatch overlay (the first build takes several minutes on 2 vCPUs):

```bash
dc="docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production"
$dc up -d --build
$dc ps                       # every service healthy
$dc run --rm ingest          # indexes the policies for the FAQ route (OpenAI embeddings)
```

Turn on the nightly backup and run it once:

```bash
cp deploy/backup.env.example deploy/backup.env
nano deploy/backup.env       # set BACKUP_BUCKET to the bucket name from step 0
sudo cp deploy/orderops-backup.service deploy/orderops-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orderops-backup.timer
sudo systemctl start orderops-backup.service
systemctl status orderops-backup.service --no-pager
```

## 9. Budget alert (creates an AWS Budget, free)

AWS Budgets is a global service whose API is served from `us-east-1`. Pick the monthly amount
(in USD) and the email address that gets the alert at 80% of it:

```bash
AMOUNT=30
ALERT_EMAIL=you@example.com
cat > $WORK/orderops-budget.json <<EOF
{"BudgetName":"orderops-monthly","BudgetLimit":{"Amount":"$AMOUNT","Unit":"USD"},
 "TimeUnit":"MONTHLY","BudgetType":"COST"}
EOF
cat > $WORK/orderops-notify.json <<EOF
[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN",
  "Threshold":80,"ThresholdType":"PERCENTAGE"},
  "Subscribers":[{"SubscriptionType":"EMAIL","Address":"$ALERT_EMAIL"}]}]
EOF
aws budgets create-budget --account-id "$ACCOUNT" --region us-east-1 \
  --budget file://$WORK/orderops-budget.json \
  --notifications-with-subscribers file://$WORK/orderops-notify.json
```

## 10. Verify

From your machine (in a new terminal, run "Recover the variables" first):

```bash
curl -s  "https://$DOMAIN/health"                    # {"status":"ok"}, valid certificate
curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/ready"   # 404 by design
aws ec2 describe-security-groups --group-ids "$SG" --region "$REGION" \
  --query 'SecurityGroups[0].IpPermissions[].[FromPort,ToPort,IpRanges[0].CidrIp]' --output text
aws ec2 describe-instances --instance-ids "$INSTANCE" --region "$REGION" \
  --query 'Reservations[0].Instances[0].[IamInstanceProfile.Arn,MetadataOptions.HttpTokens,KeyName]' \
  --output text                                      # profile arn, required, None
aws logs describe-log-streams --log-group-name "$LOG_GROUP" --region "$REGION" \
  --query 'logStreams[].logStreamName' --output text # five streams
aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "$REGION" \
  --query 'logGroups[0].retentionInDays'             # 30
aws s3 ls "s3://$BUCKET/orderops/" --region "$REGION"   # the backup from step 8
aws budgets describe-budgets --account-id "$ACCOUNT" --region us-east-1 \
  --query 'Budgets[].BudgetName'
```

On the instance (after `cd ~/order-ops` and the `dc=` line from step 8): `$dc ps` shows every
service healthy, and `env | grep -i '^AWS_'` and `aws configure list` show no access key
anywhere (the `iam-role` credentials from the instance metadata are expected).

To prove a real chat request end to end, seed the demo customers, log in and chat as in the
README walkthrough, using `https://api.arielbailon.dev` instead of `localhost:3000`:

```bash
$dc run --rm seed
```

## 11. Remove the demo customers after verifying

Before the demo is public, set `DAILY_BUDGET_USD` in `.env.production` (for example `2.00`) and
restart the gateway: once the estimated chat spend of the UTC day reaches it, chat answers with a
fixed reply until midnight UTC. Requests already running can pass the cap slightly, and costs
outside chat (evals, policy ingest, embeddings) are not counted, so keep the AWS budget alert from
section 9 as the backstop.

The seed password (`orderops-dev-password`) is published in the README, and until build-plan
item 12 adds rate limits and a spend cap, anyone who can log in can spend your model API keys.
So after the check above, delete the demo data (this also removes their orders, refund requests
and memory through the foreign keys):

```bash
$dc exec -T postgres psql -U orderops orderops -c 'TRUNCATE "Customer" CASCADE;'
```

The deploy smoke test uses its own customer (section C5), which stays. How the public demo logs
in is decided in item 12.

## Continuous deployment (GitHub Actions to this instance)

Every push to `master` runs `.github/workflows/deploy.yml`: it builds the three app images and
the `tools` image, pushes them to ECR tagged with the full commit SHA, deploys that SHA over
SSM with `deploy/deploy.sh`, smoke-tests `https://api.arielbailon.dev` with `deploy/smoke.sh`
(`/health`, a login and one real chat request) and rolls back to the previous SHA if the deploy
or the smoke test fails. The job ends red after a rollback so the failed release stays visible.
Only one deploy runs at a time (a later push waits), and the job waits for approval in the
protected `production` environment. Pull requests are checked by `ci.yml` (9c), not here: set
those checks as required in the repository settings so only a green `master` deploys.

Authentication is GitHub OIDC: the workflow assumes an IAM role that only the `production`
environment of this repository can assume. No AWS access key exists in GitHub or on the host.
Docs-only pushes (`docs/`, `blueprint/`, `*.md`, `evals/results/`) do not deploy.

### C1. ECR repositories (creates four private repositories, pennies per month)

Tags are immutable (a SHA is never overwritten) and a lifecycle policy keeps the last 10
images per repository. Use the variables from step 0.

```bash
cat > $WORK/ecr-lifecycle.json <<'EOF2'
{"rules":[{"rulePriority":1,"description":"keep the last 10 images",
 "selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},
 "action":{"type":"expire"}}]}
EOF2
for image in orderops-agent orders-service customers-service tools; do
  aws ecr create-repository --repository-name "orderops/$image" \
    --image-tag-mutability IMMUTABLE --region "$REGION"
  aws ecr put-lifecycle-policy --repository-name "orderops/$image" \
    --lifecycle-policy-text file://$WORK/ecr-lifecycle.json --region "$REGION"
done
```

### C2. Deploy role for GitHub (creates an IAM OIDC provider and role, free)

The trust policy accepts only tokens issued to the `production` environment of
`ArielBailon/order-ops`. This repository's tokens carry the owner and repository IDs in the subject
(`repo:ArielBailon@<owner id>/order-ops@<repo id>:environment:production`), so the `sub` below
must include them. If the role is refused with "Not authorized to perform sts:AssumeRoleWithWebIdentity",
read the real subject from CloudTrail (`aws cloudtrail lookup-events --lookup-attributes
AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity`, field `userIdentity.userName`). The role may push to the four repositories and run a shell command on
the one instance, nothing else.

```bash
INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values=orderops-prod Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
echo "$INSTANCE"     # must be a real id (i-...)

aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
# Newer AWS CLI versions need no --thumbprint-list for this provider; if yours asks for one, stop
# and look up GitHub's current value instead of copying one from here.

cat > $WORK/gh-trust.json <<EOF2
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Federated":"arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},
 "Action":"sts:AssumeRoleWithWebIdentity",
 "Condition":{"StringEquals":{
  "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
  "token.actions.githubusercontent.com:sub":"repo:ArielBailon@37642744/order-ops@1389972252:environment:production"}}}]}
EOF2

cat > $WORK/gh-policy.json <<EOF2
{"Version":"2012-10-17","Statement":[
 {"Sid":"EcrLogin","Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
 {"Sid":"EcrPush","Effect":"Allow",
  "Action":["ecr:BatchCheckLayerAvailability","ecr:InitiateLayerUpload","ecr:UploadLayerPart",
   "ecr:CompleteLayerUpload","ecr:PutImage","ecr:DescribeImages"],
  "Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/orderops/*"},
 {"Sid":"RunOnInstance","Effect":"Allow","Action":"ssm:SendCommand",
  "Resource":["arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE",
   "arn:aws:ssm:$REGION::document/AWS-RunShellScript"]},
 {"Sid":"ReadResult","Effect":"Allow","Action":"ssm:GetCommandInvocation","Resource":"*"}
]}
EOF2

aws iam create-role --role-name orderops-github-deploy \
  --assume-role-policy-document file://$WORK/gh-trust.json
aws iam put-role-policy --role-name orderops-github-deploy --policy-name deploy \
  --policy-document file://$WORK/gh-policy.json
aws iam get-role --role-name orderops-github-deploy --query Role.Arn --output text   # AWS_ROLE_ARN
```

### C3. Let the instance pull images (adds a policy to the instance role, free)

```bash
cat > $WORK/ecr-pull.json <<EOF2
{"Version":"2012-10-17","Statement":[
 {"Sid":"EcrLogin","Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
 {"Sid":"EcrPull","Effect":"Allow",
  "Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"],
  "Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/orderops/*"}
]}
EOF2
aws iam put-role-policy --role-name "$ROLE" --policy-name orderops-ecr-pull \
  --policy-document file://$WORK/ecr-pull.json
```

### C4. GitHub settings (you, in the repository settings)

- Environment `production`: required reviewers (you), deployment branches limited to `master`.
- Environment variables: `AWS_ROLE_ARN` (from C2), `INSTANCE_ID` (`$INSTANCE`), `AWS_REGION`
  (`us-east-1`), `SMOKE_EMAIL` (for example `smoke@arielbailon.dev`).
- Environment secret: `SMOKE_PASSWORD`, 16+ random characters (`openssl rand -hex 16`).
- Branch protection or a ruleset on `master` requiring the `ci.yml` checks (`checks`,
  `integration`, `docker`) and the `deterministic` eval job.

### C5. Smoke login (on the instance, once)

The demo customers are removed after verifying (section 11). The smoke test uses one separate
customer without orders. Type the password here; it never goes into a file or the repository.
The job refuses a password under 16 characters, and rerunning it rotates the password (update
the GitHub secret to match). The first time, the host still runs the code from before CD, which
has no `smoke-user` service, so fetch this branch (or `master` once merged) and build first.
`tools` is an image target, not a compose service: build it through `smoke-user`.

```bash
git fetch origin && git checkout master && git pull   # or the feature branch before the merge
dc="docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production"
read -r -p "SMOKE_EMAIL: " SMOKE_EMAIL
read -r -s -p "SMOKE_PASSWORD: " SMOKE_PASSWORD; echo
export SMOKE_EMAIL SMOKE_PASSWORD
$dc build smoke-user && $dc run --rm smoke-user
unset SMOKE_PASSWORD
```

### First CD deploy and rollbacks

The instance currently runs images built on the host (`TAG=local`), so the first CD deploy has
no previous release to roll back to: a failure that day leaves the stack as it is and the job
red. From the second deploy on, `deploy.sh` brings back the previous SHA by itself when the
stack does not become healthy, and the workflow does the same when the smoke test fails.

To roll back by hand, or to redeploy a known-good commit, in an SSM session as `ec2-user`:

```bash
cd ~/order-ops && git fetch origin
git checkout --detach <40-char-sha>
f=$(mktemp) && cp deploy/deploy.sh "$f"   # a private copy: the script's own checkout rewrites deploy/
APP_DIR=$PWD bash "$f" <40-char-sha> --no-rollback; rm -f "$f"
```

The image tags must still exist in ECR (the lifecycle keeps the last 10). A rollback does **not**
undo database migrations: the previous release runs against the newer schema, so write
migrations that stay compatible with the release before them (add columns and tables first,
remove them in a later release). A failed pull or checkout changes no running container, but
leaves the checkout on the new commit; check out the running SHA (`TAG` in `.env.production`)
before running compose by hand.

## Demo console (Vercel)

The Next.js console in `web/` is ready for Vercel but is **not deployed yet**: until build-plan
item 12 adds rate limits and a cost budget, a public chat page lets anyone spend the model API
keys. When item 12 is done:

1. Create a Vercel project from this repository with **Root Directory** `web`.
2. Set the environment variables `API_URL=https://api.arielbailon.dev` and `DEMO_PASSWORD`
   (the demo customers' password) as server-side variables; never prefix them with
   `NEXT_PUBLIC_`.
3. Point `demo.arielbailon.dev` at Vercel in Cloudflare (a CNAME, DNS only).
4. The console logs in as the seeded customers `ana`, `ben` and `cora`, so they must exist in
   production; section 11 removes them, and item 12 decides how they come back.

Optionally set `LANGFUSE_PROJECT_URL` (your Langfuse project URL, for example
`https://us.cloud.langfuse.com/project/<project-id>`) so the dashboard links each trace to
Langfuse. The dashboard logs in as the seeded viewer `viewer@example.com`.

The console's server calls the API from Vercel, so the gateway needs no CORS change.

## Restore a backup

The instance role can only write backups (`s3:PutObject`), on purpose, so the instance cannot
download them. Fetch the dump from your machine instead: sign a short-lived link with your own
credentials, then use it on the instance. The link is a secret for a full database dump (valid 15
minutes): paste it at the hidden prompt below, so it never lands in the shell history or the
process list.

On your machine (variables from step 0 or "Recover the variables"):

```bash
aws s3 ls "s3://$BUCKET/orderops/" --region "$REGION"        # pick a file
aws s3 presign "s3://$BUCKET/orderops/<file>.sql.gz" --expires-in 900 --region "$REGION"
```

On the instance:

```bash
cd ~/order-ops
dc="docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production"
read -rs URL                # paste the signed link, then Enter (nothing is echoed)
rm -f /tmp/restore.sql.gz   # a file left by an earlier run must not pass the gzip check below
printf 'url = "%s"\n' "$URL" | curl -fsS -K - -o /tmp/restore.sql.gz; unset URL
gzip -t /tmp/restore.sql.gz && echo "download ok"
```

Continue only if it printed `download ok`. Nothing has been changed yet, so a failure here (for
example an expired link) costs nothing: sign a new link and repeat.

The dump is plain SQL with no DROP statements, so it needs an empty database. The next block is
destructive and replaces all current data. It stops the apps (Postgres and Caddy keep running),
drops and recreates only the `orderops` database, restores, and starts everything again, with
each step chained so that the first failure stops the rest:

```bash
set -o pipefail             # a failing gunzip must fail the restore too
$dc stop orderops-agent orders-service customers-service \
  && $dc exec -T postgres psql -U orderops -d postgres \
       -c 'DROP DATABASE orderops WITH (FORCE);' -c 'CREATE DATABASE orderops;' \
  && gunzip -c /tmp/restore.sql.gz | $dc exec -T postgres psql -U orderops -d orderops \
       -v ON_ERROR_STOP=1 --single-transaction \
  && $dc up -d \
  && rm /tmp/restore.sql.gz
```

`up -d` runs `migrate` first, which finds the restored migration history and does nothing.

Do not use `down -v` for a restore: it also deletes the Caddy certificate volume (Let's Encrypt
rate limits apply) and stops Postgres, which the restore needs. `ON_ERROR_STOP` and
`--single-transaction` make a failed restore roll back, so it never leaves half the data.

If the chain stops, what to do depends on where. The dump stays in S3 in every case.

- **At `stop` or `DROP`:** the live database is intact and the apps are down (or still running).
  Nothing was lost. Fix the cause (for example a prepared transaction or replication slot blocking
  `DROP DATABASE ... WITH (FORCE)`) and run the whole block again.
- **At the restore:** the failed single transaction rolled back, so the database is empty and the
  apps are stopped. Fix the cause and run only the restore line again. Do not run `up -d` yet,
  because `migrate` would create empty tables and a later restore would fail with "already
  exists". If tables already exist, repeat the `DROP DATABASE` and `CREATE DATABASE` line first.
- **At `up -d`:** the data is fully restored. Fix the cause (a build or health problem) and run
  only `$dc up -d`, not the restore again, then `rm /tmp/restore.sql.gz` so the customer dump does
  not stay in `/tmp`.

## Check the last backup

A failing nightly backup is silent, and the 14-day lifecycle rule would then expire the last
good dump. Check about once a week, and after any password or compose change.

On the instance:

```bash
systemctl list-timers orderops-backup.timer --no-pager      # next run 03:00 UTC
systemctl status orderops-backup.service --no-pager         # last run: status=0/SUCCESS
```

From your machine, the newest object must be less than a day old:

```bash
aws s3 ls "s3://$BUCKET/orderops/" --region "$REGION" | tail -n 3
```

## Bedrock check (after AWS restores Bedrock access)

First raise the instance metadata hop limit from 1 to 2, because the gateway's Bedrock client
runs in a container and reaches the instance role through the Docker bridge. From your machine
(variables from step 0 or "Recover the variables"):

```bash
aws ec2 modify-instance-metadata-options --instance-id "$INSTANCE" --region "$REGION" \
  --http-tokens required --http-put-response-hop-limit 2
```

The tradeoff: with 2, any container (including internet-facing Caddy and the gateway) can read the
instance role's credentials (SSM core, log writes, backup `PutObject`, ECR pull) after an SSRF or a
compromise. IMDSv2 is still required. If Bedrock is turned off again, run the same command with
`--http-put-response-hop-limit 1`.

Then, on the instance, set `AWS_REGION=us-east-1` in `.env.production`, run `$dc up -d`, and
confirm Bedrock answers with the instance role: in an SSM session,
`aws bedrock-runtime converse --region us-east-1 --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 --messages '[{"role":"user","content":[{"text":"ping"}]}]'`
returns a reply without any configured key. Bedrock is only the last failover, so the app works
without it.

## Troubleshooting

- **No certificate / `curl` fails**: the DNS record must be grey-cloud and resolve to the
  Elastic IP, and ports 80 and 443 must be open. Check `docker logs` through CloudWatch (stream
  `caddy`) or `$dc logs caddy`.
- **Containers do not start with an `awslogs` error**: the log group must exist and the instance
  role must allow `logs:CreateLogStream` and `logs:PutLogEvents` on it. Check
  `aws logs describe-log-groups` and the role policy.
- **Build is killed or very slow**: check `free -m` for the swap file; stop other work on the
  instance (CD builds in GitHub Actions).
- **`migrate` fails with P3005**: the database has tables but no migration history. Do not run
  the apps before `migrate`; `docker compose ... down -v` on a fresh instance and start again.

## Teardown (reverse order; stops all charges)

In a new terminal, first run "Recover the variables" and confirm `$INSTANCE`, `$SG` and
`$ALLOC` are real ids; an empty value would make a command below fail or target the wrong thing.

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 release-address --allocation-id "$ALLOC" --region "$REGION"
aws ec2 delete-security-group --group-id "$SG" --region "$REGION"
aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
aws iam delete-instance-profile --instance-profile-name "$ROLE"
aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --role-name "$ROLE" --policy-name orderops-host
aws iam delete-role-policy --role-name "$ROLE" --policy-name orderops-ecr-pull
aws iam delete-role --role-name "$ROLE"
aws iam delete-role-policy --role-name orderops-github-deploy --policy-name deploy
aws iam delete-role --role-name orderops-github-deploy
aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
for image in orderops-agent orders-service customers-service tools; do
  aws ecr delete-repository --repository-name "orderops/$image" --force --region "$REGION"
done
aws logs delete-log-group --log-group-name "$LOG_GROUP" --region "$REGION"
aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
aws budgets delete-budget --account-id "$ACCOUNT" --budget-name orderops-monthly --region us-east-1
```

Then delete the `api` record in Cloudflare.
