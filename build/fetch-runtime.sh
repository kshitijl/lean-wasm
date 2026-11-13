#!/bin/sh
# Copy a packaged build from the build machine into runtime/ (not in git).
set -eu
HOST=${HOST:?set HOST to the build machine, as user@host}
cd "$(dirname "$0")/.."
mkdir -p runtime
scp -q "$HOST:src/lean-wasm/dist/web/{lean.js,lean.wasm,std-wp.snap,build-id}" runtime/
ls -la runtime
