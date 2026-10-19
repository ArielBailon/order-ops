#!/usr/bin/env bash
# Nightly database backup: a plain pg_dump of the production database, gzip, uploaded to S3.
# Needs BACKUP_BUCKET (see deploy/backup.env.example) and the instance role's s3:PutObject on
# s3://$BACKUP_BUCKET/orderops/*. The dump goes to a temp file first so an empty or failed
# dump is never uploaded as a "good" backup.
# Restore: gunzip -c <file>.sql.gz | docker compose ... exec -T postgres psql -U orderops orderops
set -euo pipefail

: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
cd "${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

compose=(docker compose -f docker-compose.prod.yml --env-file .env.production)
key="orderops/$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
tmp="$(mktemp -t orderops-backup.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

"${compose[@]}" exec -T postgres pg_dump -U orderops orderops | gzip > "$tmp"

# pipefail already failed the run if pg_dump did; also refuse a dump that is not a real one.
gzip -t "$tmp"
if ! gunzip -c "$tmp" | head -n 20 | grep -q "PostgreSQL database dump"; then
  echo "backup refused: output does not look like a pg_dump" >&2
  exit 1
fi

aws s3 cp "$tmp" "s3://${BACKUP_BUCKET}/${key}" --only-show-errors
echo "backup uploaded: s3://${BACKUP_BUCKET}/${key} ($(stat -c %s "$tmp") bytes)"
