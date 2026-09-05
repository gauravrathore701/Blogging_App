#!/bin/bash
# Copy the versioned hooks into .git/hooks. Run once per clone.
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel)
for h in "$repo_root"/scripts/hooks/*; do
    install -m 755 "$h" "$repo_root/.git/hooks/$(basename "$h")"
    echo "installed .git/hooks/$(basename "$h")"
done
