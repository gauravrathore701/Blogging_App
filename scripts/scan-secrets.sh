#!/bin/bash
# Refuse to let a credential — or anything from .claude/ — reach this repo.
#
# This repo is PUBLIC, so the scan is deliberately different from the one in
# pi-infra: it reads only what is STAGED, never the working tree. A tree scan
# here would walk node_modules/ and .claude/, both gitignored, and block on
# files that can never be committed anyway.
#
# Exit 0 = clean, 1 = something must not be committed.
#
# -P only. Passing -P and -E together makes grep exit with "conflicting
# matchers specified" and print nothing, which reads as clean.
set -uo pipefail

PATTERNS=(
    'github_pat_[A-Za-z0-9_]{20,}'
    'ghp_[A-Za-z0-9]{20,}'
    'xox[baprs]-[A-Za-z0-9-]{10,}'
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    'mongodb(\+srv)?://[^:/@]+:[^@]+@'
    'https://[^/@[:space:]]+:[^/@[:space:]]+@'
    '(?i)(api[_-]?key|secret|password|passwd|token)\s*[=:]\s*['"'"'"]?[A-Za-z0-9_\-]{16,}'
    '[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'   # discord bot token
    'cfut_[A-Za-z0-9]{20,}'
)

fail=0

# 1. Nothing from .claude/ may ever be staged, not even with `git add -f`.
#    It holds the infrastructure notes and research for this box.
staged_claude=$(git diff --cached --name-only | grep -E '^\.claude/' || true)
if [ -n "$staged_claude" ]; then
    echo "STAGED FROM .claude/ — this repo is public:" >&2
    echo "$staged_claude" | head -20 >&2
    fail=1
fi

# 2. Credential shapes in the staged patch itself.
staged_patch=$(git diff --cached -U0)
if [ -n "$staged_patch" ]; then
    for p in "${PATTERNS[@]}"; do
        out=$(printf '%s\n' "$staged_patch" | grep -nP -e "$p" 2>&1)
        rc=$?
        if [ "$rc" -eq 0 ]; then
            echo "POSSIBLE SECRET (/$p/):" >&2
            printf '%s\n' "$out" | sed -E 's/(.{100}).*/\1.../' | head -10 >&2
            fail=1
        elif [ "$rc" -gt 1 ]; then
            # A broken scanner must never be reported as a clean commit.
            echo "scan-secrets: grep failed on /$p/ -> $out" >&2
            fail=1
        fi
    done
fi

[ "$fail" -eq 0 ] && echo "scan-secrets: clean"
exit "$fail"
