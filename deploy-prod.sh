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

# Leak gate. Checks ONE thing before anything reaches prod: does this build
# expose personal data about Gaurav, or detail that helps someone attack this
# Pi? Two independent layers, either one blocks:
#   1. .claude/tools/leak_scan.sh   deterministic shapes (IPs, keys, UUIDs, ...)
#   2. .claude/tools/leak_review.py an independent `claude -p` per changed page
# The gate lives outside this public repo on purpose — its patterns are a list
# of what must never ship. Missing gate = refuse, never publish unscanned.
GATE=".claude/tools"
if [ ! -x "$GATE/leak_scan.sh" ] || [ ! -f "$GATE/leak_review.py" ]; then
    echo "ABORT: leak gate missing under $GATE — refusing to publish unscanned" >&2
    exit 1
fi
"$GATE/leak_scan.sh" dist || { echo "ABORT: leak_scan blocked this deploy" >&2; exit 1; }
if [ "${LEAK_GATE_SKIP_AGENT:-0}" = "1" ]; then
    echo "leak gate: agent review SKIPPED (LEAK_GATE_SKIP_AGENT=1)" >&2
else
    python3 "$GATE/leak_review.py" --build dist --live "$TARGET" \
        || { echo "ABORT: agent leak review blocked this deploy" >&2; exit 1; }
fi

cp -a dist/. "$STAGE/"

sudo mkdir -p "$TARGET"
sudo rsync -a --delete "$STAGE/" "$TARGET/"

logger -t blog-deploy "prod deployed to $TARGET"
echo "prod deployed -> $TARGET"
echo "NEXT: purge the Cloudflare cache for /blog/*"
