# Decisions

## A repository of its own (2026-11-13)

The user, after the language server first worked inside the game: "pull out the wasm build of
lean cleanly out into its own repo, with a demo page that loads it and has lsp features
working. just so that's one thing and the game content is another thing."

- This repository holds the build recipe (`build/`), the page-side library (`lib/`) and a demo
  editor (`demo/`). The game (`48-lean-web-tutorial`) loads Lean through `lib/` and
  `runtime/` of this repository.
- The library is the game's worker and client code, made general: replies carry the id of
  their request; `check` gives a result kind (`checked`, `crashed`, `timed-out`) instead of
  null; restarts after a crash happen inside the library, which opens the document again.
- The runtime's URLs carry `build-id` (written by `package.sh`), so a browser never mixes
  cached files of two builds. The game hit that mix on 2026-11-12: "ASM_CONSTS[code] is not a
  function".
- The demo's editor is CodeMirror 6, bundled with esbuild. The library itself has no
  dependencies.

## On klauria.tech, with the large files in R2 (2026-11-13)

The site serves Cloudflare static assets, which may be at most 25 MiB per file (Cloudflare's
Workers limits page, read 2026-11-13); `lean.wasm` is 132 MB and `std-wp.snap` 81 MB. So the two
go to the R2 bucket `lean-wasm-runtime`, served at `https://lean.klauria.tech/<build id>/`, and
the runtime directory on the site holds a file `big-files` with that URL (`lib/lean-host.js`).
The bucket's CORS rule allows GET from klauria.tech (and the local test origins), which is what
the cross-origin-isolated page needs; `tools/sync-to-site.sh` uploads a new build and copies the
rest into the site.

Compression is left to Cloudflare and the browser. The user: "prefer to rely on r2 and browser to
do the decompression automatically and transparently, so it can be negotiated, and so in the
future hopefully it'll just be brotli automatically if the server and browser both support".
Measured with curl through `lean.klauria.tech` on 2026-11-13:

| File | zstd | brotli | gzip | none |
|---|---|---|---|---|
| `lean.wasm` (`application/wasm`) | 20.6 MB | 23.1 MB | 22.9 MB | 131.5 MB |
| `std-wp.snap` (`application/octet-stream`) | 80.6 MB | 80.6 MB | 80.6 MB | 80.6 MB |

`application/wasm` is on Cloudflare's list of types compressed by default; `octet-stream` is not,
and both showed `cf-cache-status: DYNAMIC` (not cached at the edge). The user then added two
rules on the zone in the dashboard (the wrangler login cannot): a Compression Rule and a Cache
Rule for the host `lean.klauria.tech`. Measured again the same day, the second request onwards
a `HIT`:

| File | zstd | brotli | gzip | none |
|---|---|---|---|---|
| `lean.wasm` | 20.6 MB | 23.1 MB | 22.9 MB | 131.5 MB |
| `std-wp.snap` | 30.4 MB | 30.2 MB | 30.3 MB | 80.6 MB |

Chrome asks for zstd and gets it for both files (`test/chrome.mjs` prints each download's
encoding): about 51 MB on a first visit. The edge compresses less than brotli level 9 does
offline (26.8 MB for the image), the price of not compressing ourselves.

`test/chrome.mjs` passes with the large files from R2, against the site's build under
`wrangler dev` (`DEMO_URL=http://localhost:4321/demos/lean-wasm/demo/`).

## Framed in a page of the site (2026-11-13)

The user: "the project page in my site should actually embed the demo inside, so i can write
some text". The site frames the demo and fits the frame's height to it, so:

- A framed page is cross-origin isolated only if the page around it is too. The site's project
  page sends `Cross-Origin-Embedder-Policy: credentialless`, not `require-corp`: the site loads
  the Recurse Scout script on every page, and its server sends no `Cross-Origin-Resource-Policy`
  header, so `require-corp` would block it. With `credentialless`, Chrome isolates the page and
  the frame, Lean runs in the frame and the scout loads (headless Chrome 157, under `wrangler
  dev`). Not checked: Safari and Firefox support for `credentialless`.
- `startLean` now fails at once on a page that is not isolated, instead of after the start-up
  timeout (Lean failed inside its worker with "SharedArrayBuffer transfer requires
  self.crossOriginIsolated" and the page never heard). The demo, when framed in such a page,
  links to itself on a page of its own, which is isolated with `require-corp`.
- Heights in `vh` grow with a frame that fits itself to its content, so the editor and the
  message list are capped (`min(70vh, 40rem)`). The narrow layout's column is `minmax(0, 1fr)`:
  a plain `1fr` grew to the editor's longest line and overflowed the frame. Framed, the demo hides
  its title and introduction.
