#!/bin/bash
# Package the build for a web page: lean.js, lean.wasm, a saved library image for files that
# start with `import Std.WP` (std-wp.snap), and build-id, a name for this build that pages put
# in the runtime's URLs so that a browser never mixes cached files of two builds.
# The library copy leaves out the `.olean.private` parts: the image is 81 MB, not 255 MB.
# Run on the build machine, outside enter.sh. Writes $W/dist/web/.
set -euo pipefail
W=${W:-$HOME/src/lean-wasm}
export PATH=$W/node26/bin:$PATH
S=$W/src/build/stage1
D=$W/dist
rm -rf $D && mkdir -p $D/bin $D/lib/lean $D/web
cp $S/bin/lean $S/bin/lean.js $S/bin/lean.wasm $D/bin/
(cd $S/lib/lean && find Init Std Init.* Std.* -type f \
  \( -name "*.olean" -o -name "*.olean.server" -o -name "*.ir" -o -name "*.ir.sig" \) \
  | cpio -pdm --quiet $D/lib/lean)
printf "import Std.WP\n" > $D/probe.lean
$D/bin/lean --incr-header-save=$D/web/std-wp.snap $D/probe.lean
cp $D/bin/lean.js $D/bin/lean.wasm $D/web/
(cd $D/web && cat lean.js lean.wasm std-wp.snap | sha256sum | cut -c1-16 > build-id)
ls -la $D/web
