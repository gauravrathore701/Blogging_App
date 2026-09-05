#!/bin/bash
# Build the DEV site and swap it into /srv/blog-dev.
# Dev includes drafts and its robots.txt disallows everything.
set -euo pipefail

export PATH="/home/gaurav/.nvm/versions/node/v24.13.0/bin:$PATH"
cd "$(dirname "$0")"

TARGET=/srv/blog-dev/blog
STAGE=$(mktemp -d /tmp/blog-dev.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

npm run build:dev
cp -a dist/. "$STAGE/"

sudo mkdir -p "$TARGET"
sudo rsync -a --delete "$STAGE/" "$TARGET/"

logger -t blog-deploy "dev deployed to $TARGET"
echo "dev deployed -> $TARGET"
