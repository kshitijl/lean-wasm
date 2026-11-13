# Lean 4 in the browser, with its language server

Lean 4 compiled to WebAssembly, and a small library that runs it in a web page with no server:
whole-file checks, and Lean's own language server for one document (messages as you type, the
goal at the cursor, hover, completion, go to definition). `demo/` is an editor that uses all of
it.

The build is upstream Lean (pull request #16149 and the two it contains) with two patches of
ours. It came out of the spikes in `48-lean-web-tutorial` (see its `docs/design.md`), and that
game uses this library.

Tested in headless Chrome 157 and in desktop Chrome on an M1 Pro, and under Node 26. Not tried in
Firefox. Safari loads Lean, but a Lean thread overflows its stack on `vcgen` proofs.

## Run the demo

1. Put a packaged build in `runtime/` (not in git): `lean.js`, `lean.wasm`, `std-wp.snap` and
   `build-id`. `build/fetch-runtime.sh` copies one from the build machine.
2. `npm ci && npm run build` (bundles CodeMirror and the demo into `demo/demo.bundle.js`).
3. `uv run serve.py`, then open http://127.0.0.1:8771/demo/.

The first visit downloads about 215 MB (`lean.wasm` 132 MB, `std-wp.snap` 81 MB). Then Lean is
ready in 1 to 2 s.

## Use it in a page

The page must be cross-origin isolated: serve it with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` (`serve.py` does). Serve `lib/` and `runtime/`.

```js
import { startLean } from '/lib/lean-host.js';

const lean = startLean({ runtime: '/runtime/' });
await lean.ready();                       // start-up time in ms; throws if Lean cannot start

// A whole file, checked once.
const result = await lean.check('import Std.WP\nexample : 2 + 2 = 4 := by decide\n');
// {kind: 'checked', rc, ms, messages}, {kind: 'crashed', error, stderr} or {kind: 'timed-out'}

// The language server's one document.
lean.document.setText(text);              // {kind: 'sent' | 'unchanged', version} or {kind: 'refused'}
lean.document.onDiagnostics((diagnostics, version) => { /* LSP diagnostics */ });
const goal = await lean.document.request('$/lean/plainGoal', { position: { line: 5, character: 7 } });
```

`request` takes any LSP request about the document (`textDocument/hover`,
`textDocument/completion`, `textDocument/definition`, `$/lean/plainTermGoal`, ...) and adds the
`textDocument` parameter. It gives the result, or null.

After a crash or a check that does not finish, the library starts a new Lean by itself, opens
the document again with its latest text, and calls the `onRestart` listeners.

## Limits

- **One header.** The language server serves files that start with `import Std.WP` and import
  nothing else, because `std-wp.snap` holds exactly what that header imports. Another header
  would make the server ask for a restart, which ends the runtime, so `setText` refuses it.
  `check` has the same limit: a file with another header cannot load its imports.
- **One document.** The server keeps the file that it opened for the life of the runtime.
- **Stack depth.** Lean's threads run on the browser's stack, which is smaller than Node's.
  Very deep elaboration or long `do` blocks overflow it; the library reports this as a crash
  and restarts. The Node tests cannot see this, so `test/chrome.mjs` exists.
- **The library's sources are not there.** Go to definition works inside the document only.
- An image works only with the `lean.wasm` that saved it; `build-id` keeps the two together in
  a browser's cache.
- Not done: the infoview's interactive goals (they need Lean's RPC), `$/cancelRequest`.

## Layout

- `lib/lean-worker.js`: the worker that owns the runtime. `lib/lean-host.js`: the page side.
- `demo/`: the editor (CodeMirror 6). `demo/src/convert.js`: pure conversions between the
  language server and the editor.
- `build/`: how to make `runtime/` (below).
- `test/convert.test.mjs`: unit tests (`npm test`). `test/chrome.mjs`: the demo in headless
  Chrome, as a person uses it (needs the server). `test/lsp-node.mjs`: the language server
  through the runtime's entry points under Node, with timings
  (`node --stack-size=8192 test/lsp-node.mjs`).

## Build

Upstream: `leanprover/lean4` pull request #16149, branch `basvandijk:wasm-symbols`, commit
`6f1180cc50da91466a2819fc96af57e2719521c3` (it contains #16135 and #16142). Lean 4.37.0-pre,
Emscripten 6.0.13, Node 26. Both patches apply to that commit in order (checked 2026-11-13).

- `build/patches/browser-port.patch` makes the command-line build usable from a browser worker:
  three C entry points (`lean_wasm_boot`, `lean_wasm_load_snapshot_file`,
  `lean_wasm_check_source`), self-contained library images, no `.olean.private` parts (the
  image is 81 MB, not 255 MB), `/bin/lean` as the executable outside Node, 16 pre-started
  thread workers.
- `build/patches/lsp.patch` runs Lean's file worker (the process that an editor talks to for
  one file) on a thread of its own, with in-memory streams: `lean_wasm_lsp_start_server`,
  `lean_wasm_lsp_send_message`, `lean_wasm_lsp_receive`. The server imports through the loaded
  image instead of `.olean` files.

The build machine was a 32-core Ubuntu 22.04 desktop with no Docker and no sudo, so the build
runs in an Ubuntu 24.04 root entered with bubblewrap (`build/enter.sh`). In `~/src/lean-wasm`:

1. Unpack `ubuntu-base-24.04.5-base-amd64.tar.gz` (cdimage.ubuntu.com) into `rootfs/` with
   `tar --no-same-owner`.
2. `./enter.sh sh -c '...'` to install: `dpkg --add-architecture i386`, then
   `apt-get -o APT::Sandbox::User=root install ca-certificates git curl xz-utils bzip2 python3
   cmake make ninja-build clang lld gcc g++ gcc-multilib g++-multilib ccache libuv1-dev
   libuv1-dev:i386 libssl-dev:i386 pkgconf:i386 pkgconf file zstd rsync brotli libgmp-dev`.
3. Inside the root: clone `emscripten-core/emsdk` to `emsdk/`, `./emsdk install 6.0.13`,
   `./emsdk activate 6.0.13`. Unpack Node 26 to `node26/`.
4. `build/checkout.sh`: the source at `src/`, with both patches.
5. `./enter.sh ./build.sh`: about 10 minutes on 32 cores the first time, about 1 minute after
   a change to `Lean/Shell.lean` or the C++ only.
6. `build/package.sh` writes `dist/web/`. Then `build/fetch-runtime.sh` on your machine.

`checkout.sh`, `build.sh` and `package.sh` are the scripts that made the current runtime, with
paths made uniform. They have not been run in this form.
