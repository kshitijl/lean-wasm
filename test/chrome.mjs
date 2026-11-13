// Uses the demo page in headless Chrome as a person would: waits for Lean, reads the messages,
// puts the cursor in a proof and reads the goal, hovers a name with the mouse, types to get
// completions and ∀, Cmd-clicks a name, edits the file, breaks and restores the header, runs a
// whole-file check, and crashes Lean to see it restart with the document open again.
// Needs `uv run serve.py` (port 8771) and `npm run build`.
//
//   node test/chrome.mjs [directory for screenshots]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const S = process.argv[2] ?? fs.mkdtempSync(os.tmpdir() + '/lean-wasm-');
const PORT = 9335;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${S}/chrome-profile`,
  '--window-size=1400,1000', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 500));
};
const send = (method, params = {}) => new Promise((r) => { pending.set(++nextId, r); ws.send(JSON.stringify({ id: nextId, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result.result.value;
};
const waitFor = async (cond, what, seconds = 30) => {
  for (let i = 0; i < seconds * 10; i++) { if (await evaluate(cond)) return; await sleep(100); }
  throw new Error('timeout: ' + what + '\n' + logs.join('\n') + '\n' + await evaluate('document.body.innerText'));
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const text = (id) => evaluate(`document.getElementById('${id}').textContent`);
// Editor helpers, on the page's CodeMirror view.
const offsetOf = (needle, extra = 0) => evaluate(`demo.view.state.doc.toString().indexOf(${JSON.stringify(needle)}) + ${needle.length} + ${extra}`);
const select = (offset) => evaluate(`demo.view.focus(), demo.view.dispatch({ selection: { anchor: ${offset} } })`);
const replace = (from, to, insert) => evaluate(`demo.view.dispatch({ changes: { from: ${from}, to: ${to}, insert: ${JSON.stringify(insert)} } })`);
const coords = (offset) => evaluate(`(() => { const c = demo.view.coordsAtPos(${offset}); return { x: (c.left + c.right) / 2 + 2, y: (c.top + c.bottom) / 2 }; })()`);
const docText = () => evaluate('demo.view.state.doc.toString()');

let failed = false;
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8771/demo/' });
  await waitFor(`document.getElementById('status').textContent.startsWith('Lean started')`, 'Lean started', 120);
  console.log(await text('status'));

  // Messages as you type: the sample has a false `decide` and a `sorry`.
  await waitFor(`document.getElementById('progress').textContent === 'Checked.' && document.getElementById('messages').textContent.includes('is false')`, 'first messages');
  console.log('messages: ' + (await evaluate(`[...document.querySelectorAll('#messages li')].map((li) => li.className + ' ' + li.querySelector('button').textContent).join(', ')`)));

  // The goal at the cursor, after `split`: two cases.
  await select(await offsetOf('  split'));
  await waitFor(`document.getElementById('goal').textContent.includes('case isFalse')`, 'goal after split');
  console.log('goal after split: ' + JSON.stringify(await text('goal')));
  await shot('goal');

  // Hover, with the mouse: the signature and the doc string.
  const onCall = await coords((await offsetOf('#eval myM')) - 1);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: onCall.x, y: onCall.y });
  await waitFor(`document.querySelector('.hover')?.textContent.includes('The larger of two integers.')`, 'hover');
  console.log('hover: ' + JSON.stringify(await evaluate(`document.querySelector('.hover').innerText`)));
  await shot('hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

  // Completion while typing: `omeg` offers `omega`.
  const sorryAt = await offsetOf('  sorry', -5);
  await replace(sorryAt, sorryAt + 5, '');
  await select(sorryAt);
  for (const ch of 'omeg') await send('Input.insertText', { text: ch });
  await waitFor(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((li) => li.textContent.startsWith('omega'))`, 'completion of omeg');
  console.log('completion of "omeg": ' + await evaluate(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].slice(0, 3).map((li) => li.textContent).join(', ')`));
  await shot('completion');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // Special characters: typing \forall and a space gives ∀.
  for (const ch of ' \\forall ') await send('Input.insertText', { text: ch });
  const line = (await docText()).split('\n').find((l) => l.startsWith('  omeg'));
  if (line !== '  omeg ∀ ') throw new Error('abbreviation: ' + JSON.stringify(line));
  console.log('typing "\\forall ": ' + JSON.stringify(line));
  // Back to the sample's text for the rest.
  const at = await offsetOf('  omeg ∀ ', -9);
  await replace(at, at + 9, '  sorry');

  // Go to definition: Cmd-click on the call jumps to `def myMax`.
  const click = await coords((await offsetOf('#eval myM')) - 1);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: click.x, y: click.y, button: 'left', clickCount: 1, modifiers: 4 });
  }
  const defAt = await offsetOf('def ');
  await waitFor(`demo.view.state.selection.main.head === ${defAt}`, 'cursor on the definition');
  console.log('Cmd-click on myMax: cursor moved to its definition, line ' + await evaluate(`demo.view.state.doc.lineAt(demo.view.state.selection.main.head).number`));

  // An edit: make the false example true. Its message goes away.
  const eq = await offsetOf('myMax 2 5 = ', 0);
  await replace(eq, eq + 1, '5');
  await waitFor(`!document.getElementById('messages').textContent.includes('is false') && document.getElementById('progress').textContent === 'Checked.'`, 'message gone after the edit');
  console.log('after the edit: ' + await evaluate(`[...document.querySelectorAll('#messages li')].map((li) => li.querySelector('button').textContent).join(', ')`));

  // The header: another first line is refused, with a note; putting it back works again.
  await replace(0, 13, 'import Lean');
  await waitFor(`!document.getElementById('header-note').hidden`, 'header note');
  await replace(0, 11, 'import Std.WP');
  await waitFor(`document.getElementById('header-note').hidden`, 'header note gone');
  console.log('header: another import is refused with a note, and the original works again');

  // The whole-file check, the other entry point.
  await evaluate(`document.getElementById('check').click()`);
  await waitFor(`/messages, in/.test(document.getElementById('check-result').textContent)`, 'whole-file check');
  console.log('whole-file check: ' + await text('check-result'));

  // A crash: too deep for a browser thread. Lean restarts and the document is open again.
  const crash = await evaluate(`demo.lean.check('import Std.WP\\n#eval do\\n' + Array.from({ length: 200 }, (_, i) => '  IO.println s!"row {' + i + ' + 1}"').join('\\n')).then((r) => r.kind)`);
  if (crash !== 'crashed') throw new Error('expected a crash, got ' + crash);
  await waitFor(`document.getElementById('status').textContent.includes('restarted')`, 'restart reported');
  await evaluate('demo.lean.ready()');
  await select(await offsetOf('  split'));
  await waitFor(`document.getElementById('goal').textContent.includes('case isFalse')`, 'goal after the restart', 60);
  console.log('crash: check gave "crashed", Lean restarted, and the goal at the cursor works again');
  await shot('after-restart');
} catch (e) {
  failed = true;
  console.error('FAILED ' + String(e));
} finally {
  console.log('screenshots in ' + S);
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
