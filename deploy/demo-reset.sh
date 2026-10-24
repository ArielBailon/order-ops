#!/usr/bin/env bash
# Nightly demo reset: restores the demo accounts and orders (dates relative to now) and clears the
# demo customers' refund requests, memory and chat threads, in one transaction. Traces, the smoke
# test login and every other account stay. Runs the `demo-reset` job on the deployed tools image
# (REGISTRY and TAG come from .env.production, written by deploy/deploy.sh).
# Same compose files as deploy.sh, and --no-deps: the job only connects to the running Postgres.
# Without them compose would see a different Postgres config (no AWS logging overlay) and
# recreate the production database container.
set -euo pipefail

cd "${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

compose=(docker compose -f docker-compose.prod.yml -f docker-compose.aws.yml --env-file .env.production)
"${compose[@]}" run --rm --no-deps demo-reset
