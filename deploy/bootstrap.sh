#!/usr/bin/env bash
# One-time, idempotent host setup for Amazon Linux 2023 (x86_64 or aarch64). Run as root:
# as EC2 user data, or `sudo bash deploy/bootstrap.sh` over an SSM session.
# Installs Docker, git and a pinned Docker Compose plugin (checksum verified), adds a 2 GB
# swap file (building the images on a 2 GB instance needs it) and enables Docker on boot.
set -euo pipefail

COMPOSE_VERSION="v2.39.4"
SWAP_FILE="/swapfile"
SWAP_SIZE="2G"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

dnf install -y docker git

# Compose is not in the Amazon Linux repositories: download a pinned release and verify it.
case "$(uname -m)" in
  x86_64)
    arch="x86_64"
    sha256="7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4"
    ;;
  aarch64)
    arch="aarch64"
    sha256="49082844b87f03cdcd5f5bbef1ba8c9c897b7a2dfb80cea18d61ec8ca6117e0c"
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
plugin_dir="/usr/local/lib/docker/cli-plugins"
plugin="${plugin_dir}/docker-compose"
if ! { [ -x "$plugin" ] && echo "${sha256}  ${plugin}" | sha256sum -c --status; }; then
  mkdir -p "$plugin_dir"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL -o "$tmp" \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${arch}"
  echo "${sha256}  ${tmp}" | sha256sum -c -
  install -m 0755 "$tmp" "$plugin"
fi

if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  if [ ! -f "$SWAP_FILE" ]; then
    fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE"
  fi
  swapon "$SWAP_FILE"
fi
grep -q "^${SWAP_FILE} " /etc/fstab || echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab

systemctl enable --now docker
usermod -aG docker ec2-user

docker --version
docker compose version
