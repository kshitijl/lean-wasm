#!/bin/sh
# Puts the demo on the site klauria.tech. The site serves files of at most 25 MiB (Cloudflare's
# static assets), so:
# - lean.wasm and std-wp.snap go to the R2 bucket that lean.klauria.tech serves, under
#   <build id>/, once per build;
# - the demo, lib/ and the runtime's small files go to the site's public/demos/lean-wasm/, with
#   runtime/big-files naming that bucket's URL (see lib/lean-host.js).
# The bucket compresses nothing itself: Cloudflare's edge compresses for each browser.
# Uses the site's wrangler login. SITE defaults to ~/local-src/39-klauria-tech.
set -eu
cd "$(dirname "$0")/.."
HERE=$(pwd)
SITE=${SITE:-$HOME/local-src/39-klauria-tech}
BUCKET=lean-wasm-runtime
BIG_FILES=https://lean.klauria.tech
BUILD=$(cat runtime/build-id)

npm run build
for f in lean.wasm std-wp.snap; do
  if curl -sfI -o /dev/null "$BIG_FILES/$BUILD/$f"; then
    echo "$BUILD/$f is already in R2"
    continue
  fi
  case $f in *.wasm) type=application/wasm ;; *) type=application/octet-stream ;; esac
  (cd "$SITE" && npx wrangler r2 object put "$BUCKET/$BUILD/$f" --file "$HERE/runtime/$f" \
    --content-type $type --cache-control "public, max-age=31536000, immutable" --remote)
done

D=$SITE/public/demos/lean-wasm
rm -rf "$D"
mkdir -p "$D/demo" "$D/lib" "$D/runtime"
cp demo/index.html demo/style.css demo/demo.bundle.js "$D/demo/"
cp lib/lean-host.js lib/lean-worker.js "$D/lib/"
cp runtime/lean.js runtime/build-id "$D/runtime/"
printf '%s\n' "$BIG_FILES" > "$D/runtime/big-files"
echo "synced to $D (commit it there); the page is /demos/lean-wasm/demo/"
