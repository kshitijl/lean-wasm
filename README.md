# Lean 4 and its language server in the browser

This repo compiles Lean 4 and its LSP to WebAssembly. There's an editor demo with:
* checking the whole file
* getting goal at cursor
* messages as you type
* hover, completion, go to definition.

The point of this is for making teaching materials, like interactive games and tutorials, without having to operate backend servers running Lean. You just serve the static wasm and javascript assets.

# Things you might need to know

## Size and speed

A page that uses this build needs to download 40 MB when compressed with brotli (14 MB `lean.wasm` plus 26 MB snapshot of libraries). That decompresses to 215 MB. On my 2021 M1 Pro laptop, on Chrome, after the download it takes 1-2s for Lean to load and be ready to serve requests. That includes the browser compiling the wasm, and Lean loading the snapshot.

## Limits

- **Stack depth.** Lean's threads run on the browser's stack. That stack size can't be changed by the code, and is a bit too small for arbitrary Lean stuff you might want to do.
  Deep elaboration or long `do` blocks overflow it. The library reports this as a crash
  and restarts. Node's stack is bigger, so the Node tests can't see this. That's why `test/chrome.mjs` exists. (Emscripten also has a stack per thread whose size can be set at link time. This limit is about the browser stack, whose size is set by the browser.)
- **Header must be set at build time.** This build creates an image that's a snapshot of Lean's state after loading the header, to avoid shipping hundreds of MB of `.olean` files. So right now, every file must begin with exactly `import Std.WP` and must not have other imports.
- **One document.** The server keeps the file that it opened for the life of the runtime.
- **No library sources.** Go to definition works inside the document only.
- An image works only with the `lean.wasm` that saved it; `build-id` keeps the two together in
  a browser's cache.
- Not done: the infoview's interactive goals (they need Lean's RPC), `$/cancelRequest`.

## Compatibility

This runs successfully on desktop Chrome, Firefox and Safari. Safari is the least stable of those, mostly because it gives wasm code a much smaller stack. That matters because Lean has a lot of recursive code and ends up using a bunch of stack space.

This build *does not* work on any phone I tested, for two reasons:
* The wasm image is big, so phone browsers sometimes time out compiling it.
* Even if they compile it, doing anything useful takes too much stack space, so it crashes.

I have some ideas for fixing the stack issues (see below) but they all involve tradeoffs.

This build also runs under Node 26, although at that point I think you're (currently) better off running native Lean in a container rather than a wasm build.

## Relationship to upstream

Once upstream wasm and browser support fully lands, this repo ought to become obsolete.

As of Nov 13, 2026 this build is relatively close to upstream (Lean 4.37). In particular, it has `vcgen`, which was my original motivation for wanting a relatively recent Lean working in the browser.

It starts with pull request #16149 and adds two major patches:
- `build/patches/browser-port.patch` makes the command-line build usable from a browser worker:
  three C entry points (`lean_wasm_boot`, `lean_wasm_load_snapshot_file`,
  `lean_wasm_check_source`), self-contained library images, no `.olean.private` parts (this reduces image size from 255 MB to 81 MB), `/bin/lean` as the executable outside Node, 16 pre-started thread workers.
- `build/patches/lsp.patch` runs Lean's file worker (the process that an editor talks to for
  one file) on a thread of its own, with in-memory streams: `lean_wasm_lsp_start_server`,
  `lean_wasm_lsp_send_message`, `lean_wasm_lsp_receive`. The server imports through the loaded image instead of `.olean` files.

Then, as you might imagine, we compile using Emscripten.

# How it works

## Summary

Lean has two parts: the kernel and runtime, written in C++; and everything else, which is written in Lean and compiled to C. We use Emscripten to compile both into wasm. Next, we run `lean.wasm` on a one-line file, `import Std.WP`, and ask it to write the resulting environment to a snapshot file, like a classic Lisp image. In the browser, we read that snapshot into the wasm heap, fix up pointers for the address where it landed, and run modules' initializers.

## More details

As of Lean 4, Lean is written in Lean. There's a Lean-to-C compiler, and any build must be bootstrapped. Lean's repo contains Lean's compiler as generated C code ("stage0"). We compile that C natively as a 32-bit Linux program. It's 32-bit because wasm32 has 32-bit pointers, so we need generated C code to assume 32-bit pointers.

That native Lean-to-C compiler now compiles Lean's own sources (compiler, `Init`, `Std`) to C. We use Emscripten to compile that C, plus the C++ kernel and runtime, into `lean.wasm` and `lean.js` ("stage1"). The build also writes the library's `.olean` files.

Next, we run `lean.wasm` under Node on a one-line file, `import Std.WP`, with `--incr-header-save=std-wp.snap`. Lean imports the `.olean` files as usual and then saves the resulting environment with its compactor (`CompactedRegion.save`), which is the same mechanism that writes `.olean` files.

Note that the snapshot doesn't just dump raw heap bytes! The compactor walks the graph of Lean objects and copies them into a contiguous block, with pointers rewritten so they're relative to the start of the block. This is what gets serialized.

Our patch makes the snapshot self-contained: normally it points into the `.olean` files mapped in memory. WebAssembly can't map files at fixed addresses, so we copy everything in. Function pointers are stored as indices into `lean.wasm`'s function table, so the snapshot is tightly bound to the exact `lean.wasm` that saved it. (This is similar to how Emacs' build process works. I hope that reference lands for at least _someone_ reading this lol.)

In the browser, a worker loads `lean.js`, which instantiates `lean.wasm` and calls `lean_wasm_boot`. It fetches the snapshot and writes it to Emscripten's in-memory file system.
To load the snapshot, we read it into the wasm heap and fix up the pointers so they're relative to the address where the snapshot landed. Then we run modules' initializers, like a normal import, and keep the resulting environment as the environment for the header `import Std.WP`. Then we delete the snapshot file, since the stuff we need from it is now in memory.

From then on, the worker calls exported C functions directly according to the user's actions: `Module._lean_wasm_check_source`, `_lean_wasm_lsp_send_message`, etc. Whenever a file's header is `import Std.WP`, Lean uses the kept environment instead of attempting to read `.olean` files.

# Ideas for fixing the stack size limitation

These are roughly in order of how palatable I find them:

We could try a build with smaller stack frames, just mess around with compiler flags like `-O2` or `-Os`. It's unlikely to hugely improve things.

We could use Emscripten's Asyncify with various hop sizes. It rewrites functions so the wole call stack can be unwound nto a heap buffer and later rewound. It exists so we can pause functions, like awaiting a promise, but we can use it to avoid overflow as well: when the stack gets deep, unwind it to the heap and continue on a fresh stack. I tried this and it works, but it makes the binary bigger and slower.

We could write a new Binaryen pass that does a similar modification, targeted at some of the worst offenders in terms of recursion depth.

We could write a wasm-to-wasm compiler that rewrites recursive function calls to loops + a stack on the heap.

We could modify the Lean-to-C compiler to generate C code that uses loops + explicit stack instead of recursion.

We could modify the Lean code and C++ runtime to use less recursion throughout. I really don't think this is reasonable, I'm mostly saying it here for sake of completeness.

# How to use this

## Run the demo

1. Put a packaged build in `runtime/` (not in git): `lean.js`, `lean.wasm`, `std-wp.snap` and
   `build-id`. `build/fetch-runtime.sh` copies one from the build machine.
2. `npm ci && npm run build` (bundles CodeMirror and the demo into `demo/demo.bundle.js`).
3. `uv run serve.py`, then open http://127.0.0.1:8771/demo/.

The first visit downloads about 215 MB (`lean.wasm` 132 MB, `std-wp.snap` 81 MB). Then Lean is
ready in 1 to 2 s. Note that these are uncompressed sizes.

## Use it in a page

The page must be cross-origin isolated: serve with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` (`serve.py` does). Serve `lib/` and `runtime/`.

```js
import { startLean } from '/lib/lean-host.js';

const lean = startLean({ runtime: '/runtime/' });
await lean.ready();                       // start-up time in ms; throws if Lean cannot start

// Check the whole file
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

After a crash or a check that hangs, the library starts a new Lean, opens
the document again with its latest text, and calls the `onRestart` listeners.

