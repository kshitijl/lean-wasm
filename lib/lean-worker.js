// The worker that owns one Lean runtime: the browser build of Lean 4 (build/), with whole-file
// checks and Lean's language server for one document. Pages do not talk to it directly; they
// use lean-host.js.
//
// Its URL says where the runtime is: lean-worker.js?runtime=<directory URL>&build=<build id>.
// The build id goes into every runtime URL, so a browser never mixes cached files of two builds
// (an old lean.wasm under a new lean.js fails with "ASM_CONSTS[code] is not a function").
//
// Messages in, each with an `id` that its reply carries:
//   {id, type: 'boot', threads}       start Lean
//   {id, type: 'load_image'}          load std-wp.snap, the library image for `import Std.WP`
//   {id, type: 'check', source}       check a whole file
//   {id, type: 'lsp_start', uri, text, version}  start the language server, open the document
// and, with no reply:
//   {type: 'lsp', msg}                one JSON-RPC object for the server
// Messages out:
//   {id, type: 'booted' | 'image_loaded' | 'lsp_started', ok, ms}
//   {id, type: 'checked', rc, ms, messages, stdout, stderr}
//   {type: 'lsp', msg}                one JSON-RPC object from the server
//   {type: 'fatal', error, stderr}    the runtime is dead; the host starts a new worker
const params = new URLSearchParams(self.location.search);
const RUNTIME = (params.get('runtime') ?? '../runtime').replace(/\/$/, '');
const BUILD = params.get('build') ?? '';
const runtimeUrl = (name) => `${RUNTIME}/${name}?build=${BUILD}`;

let lines = [];     // stdout since the last request
let errLines = [];  // stderr since the last request

// When a Lean thread fails, lean.js prints the thread's error (to stderr, which ends up in
// errLines) and then rethrows it here, where its text is lost. Send the printed text first.
self.addEventListener('error', () => {
  self.postMessage({ type: 'fatal', error: 'a Lean thread failed', stderr: errLines.slice(-5) });
});

function withCString(text, f) {
  const p = Module.stringToNewUTF8(text);
  try { return f(p); } finally { Module._free(p); }
}

function boot(id, threads) {
  const t0 = performance.now();
  self.Module = {
    locateFile: (path) => runtimeUrl(path),
    mainScriptUrlOrBlob: runtimeUrl('lean.js'),
    noInitialRun: true,
    print: (text) => lines.push(text),
    printErr: (text) => errLines.push(text),
    preRun: [() => {
      for (const d of ['/bin', '/lib', '/lib/lean', '/work', '/image']) {
        try { Module.FS.mkdir(d); } catch { /* exists */ }
      }
      Module.FS.chdir('/work');
    }],
    onRuntimeInitialized: () => {
      const rc = Module._lean_wasm_boot(threads);
      self.postMessage({ id, type: 'booted', ok: rc === 0, ms: performance.now() - t0, stderr: errLines });
      errLines = [];
    },
    onAbort: (what) => self.postMessage({ type: 'fatal', error: 'aborted: ' + what, stderr: errLines }),
  };
  importScripts(runtimeUrl('lean.js'));
}

async function loadImage(id) {
  const t0 = performance.now();
  const response = await fetch(runtimeUrl('std-wp.snap'));
  if (!response.ok) throw new Error('image fetch: ' + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const path = '/image/header.snap';
  Module.FS.writeFile(path, bytes);
  // The loader reads a list of dependency regions next to the image; ours has none.
  Module.FS.writeFile(path + '.deps', '[]');
  const rc = withCString(path, (p) => Module._lean_wasm_load_snapshot_file(p));
  Module.FS.unlink(path);
  Module.FS.unlink(path + '.deps');
  self.postMessage({ id, type: 'image_loaded', ok: rc === 0, ms: performance.now() - t0, stderr: errLines });
  errLines = [];
}

// Lean prints each message as one JSON line (the format of `lean --json`).
function check(id, source) {
  lines = [];
  errLines = [];
  const t0 = performance.now();
  const rc = withCString(source, (c) => withCString('/work/Check.lean', (f) => Module._lean_wasm_check_source(c, f)));
  const messages = [];
  const stdout = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { stdout.push(line); }
  }
  self.postMessage({ id, type: 'checked', rc, ms: performance.now() - t0, messages, stdout, stderr: errLines });
}

// ---- Language server ----------------------------------------------------------------------

// The server's output, framed by Content-Length (in bytes). Polled, because the server runs on
// a thread of its own and cannot call into this worker. While a check runs, nothing is polled;
// the output waits.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let pending = new Uint8Array(0);
function lspPoll() {
  const p = Module._lean_wasm_lsp_receive();
  const chunk = Module.UTF8ToString(p);
  Module._free(p);
  if (chunk) {
    const bytes = encoder.encode(chunk);
    const joined = new Uint8Array(pending.length + bytes.length);
    joined.set(pending);
    joined.set(bytes, pending.length);
    pending = joined;
  }
  for (;;) {
    const head = decoder.decode(pending.subarray(0, Math.min(pending.length, 64)));
    const sep = head.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(head)[1]);
    if (pending.length < sep + 4 + len) return;
    const msg = JSON.parse(decoder.decode(pending.subarray(sep + 4, sep + 4 + len)));
    pending = pending.slice(sep + 4 + len);
    self.postMessage({ type: 'lsp', msg });
  }
}

function lspSend(msg) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  const text = `Content-Length: ${encoder.encode(body).length}\r\n\r\n${body}`;
  const rc = withCString(text, (p) => Module._lean_wasm_lsp_send_message(p));
  if (rc !== 0) self.postMessage({ type: 'fatal', error: 'language server: send failed: ' + rc, stderr: errLines });
}

// The file worker reads `initialize` as a request but never answers it (Lean's watchdog does,
// and there is none here), so nothing waits for its reply.
function lspStart(id, uri, text, version) {
  const t0 = performance.now();
  const ok = Module._lean_wasm_lsp_start_server() === 0;
  if (ok) {
    setInterval(lspPoll, 5);
    lspSend({ id: 0, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
    lspSend({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'lean4', version, text } } });
  }
  self.postMessage({ id, type: 'lsp_started', ok, ms: performance.now() - t0 });
}

// Emscripten starts each Lean thread as a Worker named 'em-pthread'. If it runs this script,
// the script must only load lean.js, which then takes its orders from the owning worker.
if (self.name === 'em-pthread') {
  importScripts(runtimeUrl('lean.js'));
} else self.onmessage = (event) => {
  const m = event.data;
  try {
    switch (m.type) {
      case 'boot': boot(m.id, m.threads); break;
      case 'load_image': loadImage(m.id).catch((e) => self.postMessage({ type: 'fatal', error: String(e), stderr: errLines })); break;
      case 'check': check(m.id, m.source); break;
      case 'lsp_start': lspStart(m.id, m.uri, m.text, m.version); break;
      case 'lsp': lspSend(m.msg); break;
      default: self.postMessage({ type: 'fatal', error: 'unknown message type: ' + m.type, stderr: [] });
    }
  } catch (e) {
    // 'unwind' means a Lean thread crashed and Emscripten is returning to the event loop to
    // receive that thread's error, which then arrives on stderr. Wait for it before reporting.
    setTimeout(() => self.postMessage({ type: 'fatal', error: String((e && e.stack) || e), stderr: errLines }), 500);
  }
};
