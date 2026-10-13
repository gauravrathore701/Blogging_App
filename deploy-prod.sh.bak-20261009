#!/bin/bash
# Build the PRODUCTION site and swap it into /srv/blog.
#
# NEVER run this without an explicit go from Gaurav. Same discipline as
# the discord-claude restart rule.
# See .claude/project-infrastructure/08-environments.md
set -euo pipefail

export PATH="/home/gaurav/.nvm/versions/node/v24.13.0/bin:$PATH"
cd "$(dirname "$0")"

TARGET=/srv/blog/blog
STAGE=$(mktemp -d /tmp/blog-prod.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

# Build first, into a staging dir. A failed build must never leave a
# half-written site being served.
npm run build:prod

# Belt and braces: refuse to ship if a draft slipped into the output.
if grep -rlq "Draft — visible on the dev site only" dist/ 2>/dev/null; then
    echo "ABORT: a draft post is present in the production build" >&2
    exit 1
fi

cp -a dist/. "$STAGE/"

sudo mkdir -p "$TARGET"
sudo rsync -a --delete "$STAGE/" "$TARGET/"

logger -t blog-deploy "prod deployed to $TARGET"
echo "prod deployed -> $TARGET"
echo "NEXT: purge the Cloudflare cache for /blog/*"
