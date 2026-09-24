#!/usr/bin/env bash
# Print the bot's public URL (https://…) for the InstaCloud project this checkout is linked to, or nothing
# (exit 1) when it can't be found: not linked, insta missing or not logged in, service not deployed yet.
# Usage: scripts/deployment-url.sh [--branch <name>]
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .insta/project.json ]] && command -v insta >/dev/null || exit 1
insta service list "$@" --json 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const svc = JSON.parse(s || "[]").find((x) => x.type === "compute" && x.name === "pr-shepherd");
    if (!svc?.domain) process.exit(1);
    console.log(`https://${svc.domain}`);
  });
'
