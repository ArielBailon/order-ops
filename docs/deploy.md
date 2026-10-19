# Deploying OrderOps to AWS

This runbook puts the production compose (see "Production compose" in the README) on one EC2
instance at `https://api.arielbailon.dev`: HTTPS from Caddy, logs in CloudWatch, a nightly
database backup in S3, and no AWS access keys on the server. Releases are manual for now
(`git pull` and rebuild on the instance); CI/CD is build-plan feature 9c.

Why one instance and not ECS Fargate + RDS + ALB: it is a demo, and the managed stack costs
several times more. It remains the documented next step to scale.

## Decisions

| Choice | Value | Why |
| --- | --- | --- |
| Region | `us-east-1` | The Bedrock model ids in `apps/orderops-agent/src/models/providers.ts` are `us.` inference profiles, and it is the cheapest region. Every command below passes `--region` explicitly, because a CLI default of another region (for example `sa-east-1`) would silently create resources elsewhere. |
| Instance | `t3.small` (x86_64), 30 GB gp3, encrypted | 2 vCPU and 2 GB RAM run the stack; the 2 GB swap file from `deploy/bootstrap.sh` covers image builds. x86 means the instance builds the same images your machine does. `t4g.small` (ARM) is about 20% cheaper; switch by changing `ARCH` and `TYPE` in step 6 and rebuilding. |
| Access | AWS Systems Manager Session Manager | No SSH key, no port 22. It is also what the 9c pipeline will use. |
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
  --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true}' \
  --user-data file://deploy/bootstrap.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=orderops-prod}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-status-ok --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 associate-address --instance-id "$INSTANCE" --allocation-id "$ALLOC" --region "$REGION"
```

Notes: there is no key pair (access is Session Manager). IMDSv2 is required. The hop limit of 2
lets the gateway container reach the instance role through the Docker bridge; with 1 its
Bedrock client could not get credentials. `deploy/bootstrap.sh` runs as user data (root, once)
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

From your machine:

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

On the instance: `$dc ps` shows every service healthy, and `env | grep -i '^AWS_'` and
`aws configure list` show no access key anywhere.

To prove a real chat request end to end, seed the demo customers, log in and chat as in the
README walkthrough, using `https://api.arielbailon.dev` instead of `localhost:3000`:

```bash
$dc run --rm seed
```

## 11. Remove the demo customers after verifying

The seed password (`orderops-dev-password`) is published in the README, and until build-plan
item 12 adds rate limits and a spend cap, anyone who can log in can spend your model API keys.
So after the check above, delete the demo data (this also removes their orders, refund requests
and memory through the foreign keys):

```bash
$dc exec -T postgres psql -U orderops orderops -c 'TRUNCATE "Customer" CASCADE;'
```

Whether and how a login exists for the 9c smoke test and for the public demo is decided in 9c
and item 12.

## Updating the app (manual until 9c)

```bash
cd ~/order-ops && git pull
$dc up -d --build           # migrate runs first, then the apps restart
```

## Restore a backup

```bash
aws s3 cp "s3://$BUCKET/orderops/<file>.sql.gz" /tmp/restore.sql.gz --region us-east-1
gunzip -c /tmp/restore.sql.gz | $dc exec -T postgres psql -U orderops orderops
```

A plain dump restores into an empty database: stop the apps, `down -v` the Postgres volume or
create a fresh database first, then restore, then `up -d`.

## Bedrock check (after AWS restores Bedrock access)

On the instance, set `AWS_REGION=us-east-1` in `.env.production`, run `$dc up -d`, and confirm
Bedrock answers with the instance role: in an SSM session,
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
  instance or move builds to CI (9c).
- **`migrate` fails with P3005**: the database has tables but no migration history. Do not run
  the apps before `migrate`; `docker compose ... down -v` on a fresh instance and start again.

## Teardown (reverse order; stops all charges)

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE" --region "$REGION"
aws ec2 release-address --allocation-id "$ALLOC" --region "$REGION"
aws ec2 delete-security-group --group-id "$SG" --region "$REGION"
aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
aws iam delete-instance-profile --instance-profile-name "$ROLE"
aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --role-name "$ROLE" --policy-name orderops-host
aws iam delete-role --role-name "$ROLE"
aws logs delete-log-group --log-group-name "$LOG_GROUP" --region "$REGION"
aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
aws budgets delete-budget --account-id "$ACCOUNT" --budget-name orderops-monthly --region us-east-1
```

Then delete the `api` record in Cloudflare.
