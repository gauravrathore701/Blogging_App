#!/bin/bash
# Build the DEV site and swap it into /srv/blog-dev.
#
# Dev is a review queue: by default it contains ONLY draft posts, so what
# is on dev is exactly what still needs a look. Its robots.txt disallows
# everything and Caddy tells browsers not to cache the HTML.
#
# Pass --all to include posts that are already live. Use that when you are
# reviewing edits to a published post, which is otherwise hidden here.
set -euo pipefail

export PATH="/home/gaurav/.nvm/versions/node/v24.13.0/bin:$PATH"
cd "$(dirname "$0")"

BUILD=build:dev
case "${1:-}" in
    --all) BUILD=build:dev:all ;;
    "") ;;
    *) echo "usage: $0 [--all]" >&2; exit 2 ;;
esac

TARGET=/srv/blog-dev/blog
STAGE=$(mktemp -d /tmp/blog-dev.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

npm run "$BUILD"
cp -a dist/. "$STAGE/"

sudo mkdir -p "$TARGET"
sudo rsync -a --delete "$STAGE/" "$TARGET/"

logger -t blog-deploy "dev deployed to $TARGET ($BUILD)"
echo "dev deployed -> $TARGET ($BUILD)"
