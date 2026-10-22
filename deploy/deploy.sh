#!/usr/bin/env bash
# Deploys one commit SHA on the production host. The CD workflow runs it over SSM as ec2-user:
#   deploy/deploy.sh <40-char-sha> [--no-rollback]
# It pulls that commit's images from ECR, points .env.production at them and runs the production
# compose (migrate first, then the apps; --wait fails on an unhealthy service). If the new
# release does not come up it redeploys the previous SHA and still exits non-zero. A failed
# checkout or pull changes nothing. A rollback does not revert migrations (docs/deploy.md).
# The first line of output that matters to the workflow is PREVIOUS_TAG=<value>.
set -euo pipefail

sha="${1:-}"
no_rollback=0
[ "${2:-}" = "--no-rollback" ] && no_rollback=1

# The SHA reaches git and a sed expression below, so accept nothing but a full commit hash.
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: deploy.sh <40-char commit sha> [--no-rollback]" >&2
  exit 2
fi

cd "${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
env_file=".env.production"
region="${AWS_REGION:-us-east-1}"
compose=(docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file "$env_file")

read_env() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }

set_env() {
  if grep -q "^$1=" "$env_file"; then
    sed -i "s|^$1=.*|$1=$2|" "$env_file"
  else
    echo "$1=$2" >> "$env_file"
  fi
}

# Writes the tag, then starts (or restarts) the stack on it. REGISTRY must already be set.
start() {
  set_env TAG "$1"
  "${compose[@]}" up -d --remove-orphans --wait --wait-timeout 180
}

previous="$(read_env TAG)"
echo "PREVIOUS_TAG=${previous:-}"

if [ "$previous" = "$sha" ]; then
  echo "already on ${sha}, redeploying the same release"
fi

git fetch --quiet origin
git checkout --quiet --detach "$sha"

account="$(aws sts get-caller-identity --query Account --output text --region "$region")"
registry="${account}.dkr.ecr.${region}.amazonaws.com/orderops"
registry_host="${account}.dkr.ecr.${region}.amazonaws.com"
aws ecr get-login-password --region "$region" \
  | docker login --username AWS --password-stdin "$registry_host" >/dev/null
# The login leaves a 12-hour pull token in ~/.docker/config.json; remove it however the script ends.
trap 'docker logout "$registry_host" >/dev/null 2>&1 || true' EXIT

# Pull with the new tag in the environment only: .env.production is untouched if this fails.
REGISTRY="$registry" TAG="$sha" "${compose[@]}" pull orderops-agent orders-service customers-service migrate

set_env REGISTRY "$registry"
if start "$sha"; then
  docker image prune -f >/dev/null
  echo "deployed ${sha}"
  exit 0
fi

echo "deploy of ${sha} failed" >&2
if [ "$no_rollback" -eq 1 ]; then
  echo "rollback skipped (--no-rollback)" >&2
elif [ -z "$previous" ] || [ "$previous" = "local" ]; then
  echo "no previous release to roll back to (tag: ${previous:-unset})" >&2
else
  echo "rolling back to ${previous}" >&2
  git checkout --quiet --detach "$previous"
  if start "$previous"; then
    echo "rolled back to ${previous}" >&2
  else
    echo "rollback to ${previous} failed too" >&2
  fi
fi
exit 1
