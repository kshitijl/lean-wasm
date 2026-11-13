// The page side of the browser build of Lean 4: one Lean runtime in a worker (lean-worker.js),
// with whole-file checks and Lean's language server for one document.
//
//   const lean = startLean({ runtime: '/runtime/' });
//   await lean.ready();                       // ms to start; throws if Lean cannot start
//   await lean.check(source);                 // see CheckResult below
//   lean.document.setText(text);              // the language server's one document
//   await lean.document.request('$/lean/plainGoal', { position: { line, character } });
//   lean.document.onDiagnostics((diagnostics, version) => ...);
//
// A crash or a check that does not finish ends the runtime. The host then starts a new one by
// itself, opens the document again with its latest text, and tells `onRestart` listeners.
//
// The language server serves files that start with HEADER and import nothing else, because the
// library image (std-wp.snap) holds exactly what that header imports. A different header would
// make the server ask to be restarted, which ends the runtime, so `setText` refuses it.

export const HEADER = 'import Std.WP';
/** The URI of the language server's one document, as definitions and other results name it. */
export const DOCUMENT_URI = 'file:///work/Main.lean';
const URI = DOCUMENT_URI;

/**
 * @typedef {{kind: 'checked', rc: number, ms: number, messages: object[], stdout: string[], stderr: string[]}
 *         | {kind: 'crashed', error: string, stderr: string[]}
 *         | {kind: 'timed-out'}} CheckResult
 *   `rc`: 0 no errors, 1 errors, 2 the check itself failed. `messages`: Lean's messages in the
 *   format of `lean --json`. After 'crashed' or 'timed-out' a new runtime is already starting.
 */

/** Whether the language server can take `text`: the header line, and no other import. */
export function serverAccepts(text) {
  const [first, ...rest] = text.split('\n');
  return first === HEADER && !rest.some((line) => /^\s*((public|meta|private)\s+)*import\b/.test(line));
}

export function startLean({
  runtime = new URL('../runtime/', import.meta.url).href,
  threads = 4,
  bootTimeoutMs = 120000,  // includes downloading Lean (about 215 MB) on a first visit
  checkTimeoutMs = 15000,
  requestTimeoutMs = 10000,
} = {}) {
  const base = new URL(runtime, location.href).href;
  // The build id names the runtime's files in every URL (see lean-worker.js). The optional file
  // `big-files` holds the URL of a directory with `<build id>/lean.wasm` and
  // `<build id>/std-wp.snap`, for a host that cannot serve files that large itself.
  const fetchText = (name) => fetch(new URL(name, base), { cache: 'no-store' });
  const build = Promise.all([
    fetchText('build-id').then((r) => {
      if (!r.ok) throw new Error(`no build-id in ${base} (${r.status})`);
      return r.text();
    }),
    fetchText('big-files').then((r) => (r.ok ? r.text() : '')),
  ]).then(([id, big]) => ({ id: id.trim(), big: big.trim() }));

  let worker = null;
  let started = null;  // promise of the start-up time in ms, for the current runtime
  let nextId = 1;
  const replies = new Map();  // id -> settle({kind: 'reply', msg} | {kind: 'died', error, stderr})
  const restartListeners = [];
  const document = createDocument();

  // Sends one message with an id; settles with its reply, the runtime's death, or a timeout.
  // A timeout ends the runtime: Lean is busy and cannot be stopped any other way.
  function call(message, timeoutMs) {
    const asked = worker;
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        replies.delete(id);
        resolve({ kind: 'timed-out' });
        die(asked, 'timed out on ' + message.type, []);
      }, timeoutMs);
      replies.set(id, (outcome) => { clearTimeout(timer); replies.delete(id); resolve(outcome); });
      asked.postMessage({ ...message, id });
    });
  }

  function die(dead, error, stderr) {
    if (dead !== worker) return;  // a late error from a runtime that was already replaced
    for (const settle of [...replies.values()]) settle({ kind: 'died', error, stderr });
    document.serverGone();
    spawn();
    for (const listener of restartListeners) listener(error);
  }

  function spawn() {
    if (worker) worker.terminate();
    started = (async () => {
      // Lean's threads share memory, which a browser allows only on a cross-origin isolated page
      // (the COOP and COEP headers). Without it, Lean would fail inside its worker unseen.
      if (!self.crossOriginIsolated) throw new Error('this page is not cross-origin isolated (COOP and COEP headers), which Lean needs');
      const { id, big } = await build;
      const url = new URL('./lean-worker.js', import.meta.url);
      url.search = new URLSearchParams({ runtime: base, build: id, big }).toString();
      const w = new Worker(url);
      worker = w;
      w.onmessage = (event) => {
        if (w !== worker) return;
        const m = event.data;
        if (m.type === 'lsp') document.receive(m.msg);
        else if (m.type === 'fatal') die(w, m.error, m.stderr ?? []);
        else replies.get(m.id)?.({ kind: 'reply', msg: m });
      };
      w.onerror = (event) => die(w, event.message ?? 'worker error', []);
      const t0 = performance.now();
      const step = async (message, what) => {
        const outcome = await call(message, bootTimeoutMs);
        if (outcome.kind !== 'reply' || !outcome.msg.ok) throw new Error(`Lean did not start: ${what} failed`);
      };
      await step({ type: 'boot', threads }, 'boot');
      await step({ type: 'load_image' }, 'loading the library image');
      await step({ type: 'lsp_start', uri: URI, ...document.openWith() }, 'starting the language server');
      document.serverReady((message) => w.postMessage({ type: 'lsp', msg: message }));
      return Math.round(performance.now() - t0);
    })();
    started.catch(() => {});  // reported where `ready` is awaited
  }

  /** @returns {Promise<CheckResult>} */
  async function check(source) {
    await started;
    const outcome = await call({ type: 'check', source }, checkTimeoutMs);
    switch (outcome.kind) {
      case 'reply': {
        const { rc, ms, messages, stdout, stderr } = outcome.msg;
        return { kind: 'checked', rc, ms, messages, stdout, stderr };
      }
      case 'died': return { kind: 'crashed', error: outcome.error, stderr: outcome.stderr };
      case 'timed-out': return { kind: 'timed-out' };
      default: throw new Error('unknown outcome: ' + outcome.kind);
    }
  }

  function createDocument() {
    let text = HEADER + '\n';  // the latest text the page gave
    let version = 1;
    let sent = null;           // the text the server has; null while there is no server
    let post = null;           // sends to the server; null while there is no server
    let nextRequestId = 1;
    const waiting = new Map(); // request id -> resolve
    const diagnosticListeners = [];
    const progressListeners = [];

    return {
      get version() { return version; },
      get text() { return text; },
      /** @returns {{kind: 'sent' | 'unchanged', version: number} | {kind: 'refused'}} */
      setText(newText) {
        if (!serverAccepts(newText)) return { kind: 'refused' };
        if (newText === text) return { kind: 'unchanged', version };
        text = newText;
        version += 1;
        if (post !== null) {
          sent = text;
          post({ method: 'textDocument/didChange', params: { textDocument: { uri: URI, version }, contentChanges: [{ text }] } });
        }
        return { kind: 'sent', version };
      },
      /** A request about the document; `params` gets `textDocument`. The result, or null. */
      async request(method, params = {}) {
        await started;
        if (post === null) return null;
        return new Promise((resolve) => {
          const id = nextRequestId++;
          const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, requestTimeoutMs);
          waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg.error ? null : msg.result); });
          post({ id, method, params: { textDocument: { uri: URI }, ...params } });
        });
      },
      /** `listener(diagnostics, version)` on each `textDocument/publishDiagnostics`. */
      onDiagnostics(listener) { diagnosticListeners.push(listener); },
      /** `listener(ranges, version)` on `$/lean/fileProgress`; no ranges: elaboration is done. */
      onProgress(listener) { progressListeners.push(listener); },

      // ---- For the host only ----
      openWith() { return { text, version }; },
      serverReady(postToServer) {
        post = postToServer;
        // The text may have changed while the server started.
        if (sent !== text) {
          sent = text;
          post({ method: 'textDocument/didChange', params: { textDocument: { uri: URI, version }, contentChanges: [{ text }] } });
        }
      },
      serverGone() {
        post = null;
        sent = null;
        for (const resolve of waiting.values()) resolve({ error: 'restarted' });
        waiting.clear();
      },
      receive(msg) {
        if (msg.method === undefined) {
          waiting.get(msg.id)?.(msg);
          waiting.delete(msg.id);
        } else if (msg.id !== undefined) {
          post?.({ id: msg.id, result: null });  // a request from the server: nothing to say
        } else if (msg.method === 'textDocument/publishDiagnostics') {
          for (const listener of diagnosticListeners) listener(msg.params.diagnostics, msg.params.version);
        } else if (msg.method === '$/lean/fileProgress') {
          for (const listener of progressListeners) listener(msg.params.processing, msg.params.textDocument.version);
        }
      },
    };
  }

  spawn();
  return {
    /** Resolves to the start-up time in ms of the current runtime; throws if it cannot start. */
    ready: () => started,
    check,
    document: {
      get version() { return document.version; },
      get text() { return document.text; },
      setText: document.setText,
      request: document.request,
      onDiagnostics: document.onDiagnostics,
      onProgress: document.onProgress,
    },
    /** `listener(reason)` after a crash or timeout, when a new runtime starts. */
    onRestart(listener) { restartListeners.push(listener); },
    stop() { worker?.terminate(); worker = null; },
  };
}
