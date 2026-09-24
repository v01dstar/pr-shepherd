#!/usr/bin/env bash
# Cut a release: bump the version everywhere, commit, tag. Does NOT push.
# Usage: scripts/release.sh <x.y.z>
#   1. requires a clean working tree and passing typecheck + tests
#   2. sets the version in package.json + package-lock.json (npm version --no-git-tag-version)
#      in insta.template.yaml (version and the image tag) and in .claude-plugin/plugin.json
#   3. commits "Release vX.Y.Z" and tags vX.Y.Z
# Then push (printed at the end); the tag triggers .github/workflows/release.yml, which builds
# ghcr.io/<owner>/pr-shepherd:<x.y.z> (+ :latest) for linux/amd64 and linux/arm64.
#
# One-time, after the first release: make the GHCR package public, or InstaCloud template deploys
# cannot pull it (they pull anonymously): GitHub → your profile → Packages → pr-shepherd →
# Package settings → Danger Zone → Change visibility → Public.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: scripts/release.sh <x.y.z>}"
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be x.y.z, got: $VERSION" >&2; exit 2; }
TAG="v$VERSION"

[[ -z "$(git status --porcelain)" ]] || { echo "working tree is not clean; commit or stash first" >&2; git status --short >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "tag $TAG already exists" >&2; exit 1; }

echo "==> typecheck + tests"
npm run typecheck
npm test

echo "==> bump to $VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
# insta.template.yaml: top-level version and the pinned image tag.
node - "$VERSION" <<'JS'
const fs = require('fs');
const v = process.argv[2];
const f = 'insta.template.yaml';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(/^version:.*$/m, `version: "${v}"`);
s = s.replace(/^(\s+image:\s*ghcr\.io\/[^\s:]+\/pr-shepherd):[^\s#]+/m, `$1:${v}`);
if (!/^version: "/m.test(s) || !s.includes(`/pr-shepherd:${v}`)) { console.error(`${f}: could not update version/image`); process.exit(1); }
if (s !== before) fs.writeFileSync(f, s);
const pf = '.claude-plugin/plugin.json';
const plugin = JSON.parse(fs.readFileSync(pf, 'utf8'));
plugin.version = v;
fs.writeFileSync(pf, JSON.stringify(plugin, null, 2) + '\n');
JS

git add package.json package-lock.json insta.template.yaml .claude-plugin/plugin.json
git commit -m "Release $TAG"
git tag -a "$TAG" -m "Release $TAG"

branch="$(git rev-parse --abbrev-ref HEAD)"
cat <<MSG

Tagged $TAG. Publish it with:
  git push origin $branch $TAG
The tag builds and pushes the image (GitHub → Actions → release). First release only: make the
GHCR package public (GitHub → Packages → pr-shepherd → Package settings → Change visibility).
MSG
