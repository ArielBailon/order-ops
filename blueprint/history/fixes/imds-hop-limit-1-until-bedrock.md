# Fix: Launch with IMDS hop limit 1 until Bedrock is used

**Type:** Fix
**Status:** verified
**Branch:** fix/imds-hop-limit-1-until-bedrock
**Fixes:** F-08

## The problem

The launch command in [docs/deploy.md](docs/deploy.md#L204) sets `HttpPutResponseHopLimit=2` on the instance. A hop limit of 2 lets any container, including internet-facing Caddy and the LLM gateway, fetch the instance role's credentials from the metadata service after an SSRF or a container compromise. The role now covers SSM core, log writes, backup `PutObject` and ECR pull. The runbook justifies the setting only for Bedrock, which is disabled (`AWS_REGION` empty) and was never verified. IMDSv2 is still required, so the exposure is modest. Nothing else needs the higher limit: the `awslogs` driver and `deploy.sh` run on the host, which is one hop.

## The fix

Documentation only, in `docs/deploy.md`:

- In the launch command (step 6), set `HttpPutResponseHopLimit=1`, and rewrite the note under it to say why: the hop limit of 1 keeps containers from reaching the role credentials; Bedrock from a container needs 2, which the "Bedrock check" step turns on.
- In "Bedrock check (after AWS restores Bedrock access)", add the step that raises the limit before setting `AWS_REGION`, run from the operator's machine with the variables from step 0: `aws ec2 modify-instance-metadata-options --instance-id "$INSTANCE" --http-tokens required --http-put-response-hop-limit 2 --region "$REGION"`, with a sentence naming the tradeoff (containers can then read the role credentials) and that it can be set back to 1 with the same command if Bedrock is turned off again.

Must not break: the rest of the launch command and its notes, the existing Bedrock verification command, and every other section. Out of scope: changing the running instance (it stays at 2 until the owner decides to change it, which is a separate, explicit AWS action), Terraform or any other tooling, F-19 and the other findings.

## Build steps

- [x] 1. Update the launch command and its note (step 6). Done when: the launch command in `docs/deploy.md` shows `HttpPutResponseHopLimit=1`, the note no longer claims the gateway needs 2 today, and `grep -n "HttpPutResponseHopLimit" docs/deploy.md` shows exactly the places expected (the launch line, plus the Bedrock step from step 2).
- [x] 2. Add the raise-and-revert instructions to "Bedrock check". Done when: the section lists the `modify-instance-metadata-options` command with `--region "$REGION"` and the step-0 variables (`$INSTANCE`), states the credentials-exposure tradeoff and how to set it back to 1, appears before the `AWS_REGION` change, and the section's code blocks pass `bash -n`; `git diff` touches only `docs/deploy.md`.

## Verify

Docs only: read the diff against F-08's suggested fix. I will not run any AWS command, so the running instance is unchanged and the new Bedrock step has not been exercised (Bedrock access is still suspended). The finding stays `fixed`, not `closed`, until `/audit` re-reviews it, and it should say plainly that the live instance still has hop limit 2.


<!-- blueprint:completion {"schemaVersion":1,"specBytes":3102,"specSha256":"5866c59d250515abe62b3fedcfbb1231bac93b372c8622ccb749f32802b49c4c","branch":"refs/heads/fix/imds-hop-limit-1-until-bedrock","head":"04d2bed24dee3cb0935c11086c091e7658d32020","baseRef":"refs/heads/master","baseCommit":"04d2bed24dee3cb0935c11086c091e7658d32020","sourceTree":"eb03d311ee283d32b7360e3988e1563e889b9695","absentOptional":[]} -->

## Completion note

Documentation only. The RUNNING instance still has metadata hop limit 2: changing it (`aws ec2 modify-instance-metadata-options ... --http-put-response-hop-limit 1`) is a separate, explicit AWS action left to the owner. The new Bedrock-check step was not exercised because Bedrock access is still suspended. F-08 stays `fixed` in the findings ledger until `/audit` re-reviews it, and a `fixed` entry is never archived. No independent review receipt: project policy is `manual` and none was requested.
