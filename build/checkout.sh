#!/bin/sh
# Check out the Lean source this build is made from and apply the two patches.
# Run on the build machine, outside enter.sh. Writes $W/src (a git worktree of $W/lean4).
set -eu
W=${W:-$HOME/src/lean-wasm}
HERE=$(cd "$(dirname "$0")" && pwd)
# The head of leanprover/lean4 pull request #16149 (it contains #16135 and #16142).
COMMIT=6f1180cc50da91466a2819fc96af57e2719521c3
test -d $W/lean4 || git clone https://github.com/leanprover/lean4.git $W/lean4
cd $W/lean4
git remote get-url basvandijk >/dev/null 2>&1 || git remote add basvandijk https://github.com/basvandijk/lean4.git
git fetch basvandijk wasm-symbols
git worktree add --detach $W/src $COMMIT
cd $W/src
git apply $HERE/patches/browser-port.patch
git apply $HERE/patches/lsp.patch
echo "checked out $COMMIT with both patches in $W/src"
