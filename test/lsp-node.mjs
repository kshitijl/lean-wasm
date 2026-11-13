// Spike: Lean's own language server (one file worker) inside the browser build, driven from
// Node through the entry points of build/patches/lsp.patch. Speaks LSP to it as an editor would and
// prints what comes back, with timings.
//
//   node --stack-size=8192 test/lsp-node.mjs       (runtime from runtime/)
//   LEAN_RUNTIME=dir node --stack-size=8192 test/lsp-node.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = process.env.LEAN_RUNTIME || path.join(HERE, '..', 'runtime');
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

function boot() {
  return new Promise((resolve, reject) => {
    const errLines = [];
    const leanJs = path.join(RUNTIME, 'lean.js');
    const withCString = (text, f) => {
      const p = Module.stringToNewUTF8(text);
      try { return f(p); } finally { Module._free(p); }
    };
    const Module = {
      noInitialRun: true,
      print: (text) => console.log('[lean stdout]', text),
      printErr: (text) => { errLines.push(text); console.log('[lean stderr]', text); },
      preRun: [() => {
        for (const d of ['/bin', '/lib', '/lib/lean', '/work', '/image']) {
          try { Module.FS.mkdir(d); } catch { /* exists */ }
        }
        Module.FS.chdir('/work');
        // Lean's threads are Node workers whose `__filename` is the real path of lean.js, and
        // Lean asks for its executable's directory from such a thread. Make that path exist in
        // the virtual file system. (In a browser Lean reports `/bin/lean` instead.)
        Module.FS.mkdirTree(RUNTIME);
        Module.FS.writeFile(path.join(RUNTIME, 'lean.js'), '');
      }],
      onRuntimeInitialized: () => {
        try {
          globalThis.__filename = '/bin/lean';
          globalThis.__dirname = '/bin';
          Module.FS.writeFile('/bin/lean', '');
          if (Module._lean_wasm_boot(4) !== 0) throw new Error('boot failed');
          const image = '/image/header.snap';
          Module.FS.writeFile(image, fs.readFileSync(path.join(RUNTIME, 'std-wp.snap')));
          Module.FS.writeFile(image + '.deps', '[]');
          if (withCString(image, (p) => Module._lean_wasm_load_snapshot_file(p)) !== 0) throw new Error('image load failed');
          resolve({ Module, withCString });
        } catch (e) { reject(e); }
      },
      onAbort: (what) => reject(new Error('aborted: ' + what + '\n' + errLines.join('\n'))),
    };
    globalThis.Module = Module;
    globalThis.require = createRequire(import.meta.url);
    globalThis.__filename = leanJs;
    globalThis.__dirname = RUNTIME;
    vm.runInThisContext(fs.readFileSync(leanJs, 'utf8'), { filename: leanJs });
  });
}

// LSP framing over the two entry points. `receive` polls; responses are matched by id.
function lspClient({ Module, withCString }) {
  let pending = Buffer.alloc(0);
  const waiting = new Map();   // id -> resolve
  const notes = [];            // notifications, in order
  let nextId = 1;
  const send = (msg) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    const text = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const rc = withCString(text, (p) => Module._lean_wasm_lsp_send_message(p));
    if (rc !== 0) throw new Error('send failed: ' + rc);
  };
  const poll = () => {
    const p = Module._lean_wasm_lsp_receive();
    const chunk = Module.UTF8ToString(p);
    Module._free(p);
    if (chunk) pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      const sep = pending.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, sep).toString())[1]);
      if (pending.length < sep + 4 + len) return;
      const msg = JSON.parse(pending.subarray(sep + 4, sep + 4 + len).toString());
      pending = pending.subarray(sep + 4 + len);
      if (msg.id !== undefined && waiting.has(msg.id) && msg.method === undefined) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      } else {
        notes.push({ at: ms(), msg });
      }
    }
  };
  setInterval(poll, 5);
  return {
    notes,
    notify: (method, params) => send({ method, params }),
    request: (method, params) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    }),
    // Resolves when a notification satisfies `pred`, looking at ones not yet consumed.
    waitFor: (pred, label, timeoutMs = 60000) => new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = () => {
        const i = notes.findIndex((n) => pred(n.msg));
        if (i >= 0) return resolve(notes.splice(0, i + 1).at(-1));
        if (performance.now() - start > timeoutMs) return reject(new Error('timeout: ' + label));
        setTimeout(tick, 5);
      };
      tick();
    }),
  };
}

const URI = 'file:///work/Game.lean';
const TEXT = `import Std.WP
def myMax (a b : Int) : Int := if a < b then b else a

theorem myMax_ge (a b : Int) : myMax a b >= a := by
  unfold myMax
  split
  omega
  omega
`;
// Positions are 0-based (line, UTF-16 character), as in LSP.
const AFTER_SPLIT = { line: 5, character: 7 };
const ON_MYMAX = { line: 3, character: 32 };

const lean = await boot();
console.log(`${ms()} ms: Lean booted, image loaded`);
const rc = lean.Module._lean_wasm_lsp_start_server();
console.log(`${ms()} ms: server started, rc ${rc}`);
const lsp = lspClient(lean);
const doc = { uri: URI };
const isDiag = (m) => m.method === 'textDocument/publishDiagnostics';
const doneProgress = (m) => m.method === '$/lean/fileProgress' && m.params.processing.length === 0;

// The file worker reads `initialize` as a request but never answers it (the watchdog does), so
// the request is sent without waiting for a reply.
lsp.request('initialize', { processId: null, rootUri: null, capabilities: {} });
lsp.notify('textDocument/didOpen', { textDocument: { uri: URI, languageId: 'lean4', version: 1, text: TEXT } });
let n = await lsp.waitFor(doneProgress, 'first elaboration');
console.log(`${n.at} ms: file elaborated`);
const diags = lsp.notes.concat([n]).filter((x) => isDiag(x.msg));
console.log('notifications so far:', [...new Set(lsp.notes.map((x) => x.msg.method))]);

const show = (label, t, r) => console.log(`\n${label} (${Math.round(performance.now() - t)} ms):\n${JSON.stringify(r.result ?? r.error, null, 1).slice(0, 1500)}`);
let t = performance.now();
show('plainGoal after `split`', t, await lsp.request('$/lean/plainGoal', { textDocument: doc, position: AFTER_SPLIT }));
t = performance.now();
show('plainTermGoal on `myMax`', t, await lsp.request('$/lean/plainTermGoal', { textDocument: doc, position: ON_MYMAX }));
t = performance.now();
show('hover on `myMax`', t, await lsp.request('textDocument/hover', { textDocument: doc, position: ON_MYMAX }));
t = performance.now();
// Completion of a partial word, as an editor asks for it while the player types `omeg`.
lsp.notify('textDocument/didChange', { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: TEXT.replace(/  omega\n$/, '  omeg\n') }] });
await lsp.waitFor(doneProgress, 'elaboration of the partial word');
const comp = await lsp.request('textDocument/completion', { textDocument: doc, position: { line: 7, character: 6 } });
console.log(`\ncompletion at "omega" (${Math.round(performance.now() - t)} ms): ${comp.result ? (comp.result.items ?? comp.result).length + ' items, e.g. ' + (comp.result.items ?? comp.result).slice(0, 5).map((i) => i.label).join(', ') : JSON.stringify(comp.error)}`);

// An edit: drop the last `omega`. Lean re-elaborates and reports the unsolved goal.
t = performance.now();
const edited = TEXT.replace(/  omega\n$/, '');
lsp.notify('textDocument/didChange', { textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: edited }] });
n = await lsp.waitFor((m) => isDiag(m) && m.params.version === 3 && m.params.diagnostics.length > 0, 'diagnostics after edit');
console.log(`\nafter edit (${Math.round(performance.now() - t)} ms): ${n.msg.params.diagnostics.map((d) => `line ${d.range.start.line}: ${d.message.split('\n')[0]}`).join(' | ')}`);
console.log('first diagnostics seen:', diags.length);
globalThis.PThread.terminateAllThreads();
process.exit(0);
