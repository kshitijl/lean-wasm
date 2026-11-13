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
