// The demo page: a Lean editor in the browser, with no server. CodeMirror is the editor; Lean's
// own language server (lib/lean-host.js) gives the messages as you type, the goal at the
// cursor, hover, completion and go to definition.
import { EditorView, basicSetup } from 'codemirror';
import { hoverTooltip } from '@codemirror/view';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { autocompletion } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
// Not bundled: the host finds its worker next to itself.
import { startLean, DOCUMENT_URI } from '/lib/lean-host.js';
import { expandAbbreviation, markdownBlocks, offsetToPosition, positionToOffset, toEditorDiagnostics } from './convert.js';

const $ = (id) => document.getElementById(id);
const SAMPLE = `import Std.WP

/-- The larger of two integers. -/
def myMax (a b : Int) : Int := if a < b then b else a

#eval myMax 3 7

-- Put the cursor on a line of the proof to see the goal there.
-- Hover a name to see its type. Cmd-click (Ctrl-click) a name to go to its definition.
theorem myMax_ge_left (a b : Int) : myMax a b ≥ a := by
  unfold myMax
  split
  · omega
  · omega

-- Lean says why this one is false.
example : myMax 2 5 = 2 := by decide

-- Type \\forall and a space for ∀. Replace sorry with "omeg" to see completions.
theorem le_myMax (a b : Int) : ∀ c, c ≤ a → c ≤ myMax a b := by
  intro c h
  sorry
`;

const lean = startLean();
const status = (text) => { $('status').textContent = text; };
lean.ready().then((ms) => status(`Lean started in ${ms} ms.`), (e) => status(`${e.message}. Reload the page.`));
lean.onRestart((reason) => status(`Lean stopped (${reason}) and was restarted.`));

// ---- Lean syntax, roughly: comments, strings, numbers and keywords ------------------------
const KEYWORDS = new Set(('def theorem lemma example abbrev structure inductive class instance where '
  + 'fun let mut if then else match with do for in return by have show from at import open namespace '
  + 'section end variable universe deriving private protected noncomputable partial termination_by '
  + 'decreasing_by calc').split(' '));
const leanSyntax = StreamLanguage.define({
  startState: () => ({ commentDepth: 0 }),
  token(stream, state) {
    if (state.commentDepth > 0) {
      if (stream.match('/-')) state.commentDepth += 1;
      else if (stream.match('-/')) state.commentDepth -= 1;
      else stream.next();
      return 'comment';
    }
    if (stream.match('--')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/-')) { state.commentDepth = 1; return 'comment'; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^#[a-z_]+/)) return 'keyword';
    const word = stream.match(/^[A-Za-z_][\w'.!?]*/);
    if (word) return KEYWORDS.has(word[0]) ? 'keyword' : null;
    stream.next();
    return null;
  },
});

// ---- The document: every change goes to Lean -------------------------------------------
function sync(view) {
  const result = lean.document.setText(view.state.doc.toString());
  switch (result.kind) {
    case 'sent': case 'unchanged': $('header-note').hidden = true; return true;
    case 'refused': $('header-note').hidden = false; return false;
    default: throw new Error('unknown result: ' + result.kind);
  }
}

const positionAt = (view, offset) => offsetToPosition(view.state.doc.toString(), offset);

lean.document.onDiagnostics((diagnostics, version) => {
  if (version !== lean.document.version) return;  // about an older text
  const text = lean.document.text;
  const shown = toEditorDiagnostics(text, diagnostics).sort((a, b) => a.from - b.from);
  view.dispatch(setDiagnostics(view.state, shown));
  $('messages').replaceChildren(...shown.map((d) => {
    const item = document.createElement('li');
    item.className = d.severity;
    const where = document.createElement('button');
    where.textContent = `line ${d.line}`;
    where.onclick = () => { view.dispatch({ selection: { anchor: d.from }, scrollIntoView: true }); view.focus(); };
    const message = document.createElement('pre');
    message.textContent = d.message;
    item.append(where, message);
    return item;
  }));
  if (shown.length === 0) $('messages').replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No messages.' }));
});

lean.document.onProgress((ranges, version) => {
  if (version !== lean.document.version) return;
  $('progress').textContent = ranges.length === 0 ? 'Checked.'
    : `Checking from line ${ranges[0].range.start.line + 1}.`;
});

// ---- The goal at the cursor --------------------------------------------------------------
let goalTimer = null;
let goalAsked = 0;
function showGoalSoon(view) {
  clearTimeout(goalTimer);
  goalTimer = setTimeout(() => showGoal(view), 80);
}
async function showGoal(view) {
  if (!sync(view)) return;
  const asked = ++goalAsked;
  const position = positionAt(view, view.state.selection.main.head);
  const [goal, term] = await Promise.all([
    lean.document.request('$/lean/plainGoal', { position }),
    lean.document.request('$/lean/plainTermGoal', { position }),
  ]);
  if (asked !== goalAsked) return;  // the cursor moved on
  const goals = goal?.goals ?? null;
  $('goal').textContent = goals !== null
    ? (goals.length === 0 ? 'No goals.' : goals.join('\n\n'))
    : term?.goal ? 'Expected type:\n' + term.goal : 'No goal at the cursor.';
}

// ---- Hover -------------------------------------------------------------------------------
const hover = hoverTooltip(async (view, offset) => {
  if (!sync(view)) return null;
  const result = await lean.document.request('textDocument/hover', { position: positionAt(view, offset) });
  const value = typeof result?.contents === 'string' ? result.contents : result?.contents?.value;
  if (!value) return null;
  const text = view.state.doc.toString();
  const from = result.range ? positionToOffset(text, result.range.start) : offset;
  const to = result.range ? positionToOffset(text, result.range.end) : offset;
  return {
    pos: from, end: to, above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'hover';
      for (const block of markdownBlocks(value)) {
        const el = document.createElement(block.kind === 'code' ? 'pre' : 'p');
        el.textContent = block.text;
        dom.append(el);
      }
      return { dom };
    },
  };
}, { hoverTime: 250 });

// ---- Completion --------------------------------------------------------------------------
// Lean completes the last part of a dotted name: `Nat.su` offers `sub`, `succ`, ...
const KINDS = { 2: 'method', 3: 'function', 5: 'property', 6: 'variable', 7: 'class', 9: 'namespace', 14: 'keyword', 22: 'type' };
async function leanCompletions(context) {
  const word = context.matchBefore(/[\w'.]+/);
  if (word === null && !context.explicit) return null;
  const view = context.view;
  if (!sync(view)) return null;
  const result = await lean.document.request('textDocument/completion', { position: positionAt(view, context.pos) });
  const items = result?.items ?? result ?? [];
  if (items.length === 0) return null;
  const lastDot = word === null ? -1 : word.text.lastIndexOf('.');
  return {
    from: word === null ? context.pos : word.from + lastDot + 1,
    options: items.map((item) => ({ label: item.label, detail: item.detail, type: KINDS[item.kind] })),
    validFor: /^[\w']*$/,
  };
}

// ---- Go to definition: Cmd-click (Ctrl-click) --------------------------------------------
async function goToDefinition(view, offset) {
  if (!sync(view)) return;
  const result = await lean.document.request('textDocument/definition', { position: positionAt(view, offset) });
  const first = Array.isArray(result) ? result[0] : result;
  if (!first) { status('No definition found there.'); return; }
  const uri = first.targetUri ?? first.uri;
  const range = first.targetSelectionRange ?? first.range;
  if (uri !== DOCUMENT_URI) { status(`Defined in Lean's library: ${uri.replace(/^file:\/\//, '')}`); return; }
  const at = positionToOffset(view.state.doc.toString(), range.start);
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

// ---- Special characters: \forall and a space gives ∀ -----------------------------------
const abbreviations = EditorView.inputHandler.of((view, from, to, inserted) => {
  if (inserted.length !== 1) return false;
  const before = view.state.doc.sliceString(Math.max(0, from - 20), from) + inserted;
  const expanded = expandAbbreviation(before);
  if (expanded === null) return false;
  const start = from - (before.length - inserted.length);
  view.dispatch({ changes: { from: start, to, insert: expanded }, selection: { anchor: start + expanded.length } });
  return true;
});

const view = new EditorView({
  doc: SAMPLE,
  parent: $('editor'),
  extensions: [
    basicSetup,
    leanSyntax,
    lintGutter(),
    hover,
    autocompletion({ override: [leanCompletions] }),
    abbreviations,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) sync(update.view);
      if (update.docChanged || update.selectionSet) showGoalSoon(update.view);
    }),
    EditorView.domEventHandlers({
      mousedown(event, v) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const offset = v.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) return false;
        goToDefinition(v, offset);
        return true;
      },
    }),
  ],
});
sync(view);
lean.ready().then(() => showGoal(view), () => {});

// ---- A whole-file check, the other entry point -------------------------------------------
$('check').onclick = async () => {
  $('check-result').textContent = 'Checking.';
  const result = await lean.check(view.state.doc.toString());
  switch (result.kind) {
    case 'checked': {
      const errors = result.messages.filter((m) => m.severity === 'error').length;
      $('check-result').textContent = `${errors} error${errors === 1 ? '' : 's'}, ${result.messages.length} messages, in ${Math.round(result.ms)} ms.`;
      break;
    }
    case 'crashed': $('check-result').textContent = `Lean crashed (${result.error}) and was restarted.`; break;
    case 'timed-out': $('check-result').textContent = 'The check did not finish in time. Lean was restarted.'; break;
    default: throw new Error('unknown result: ' + result.kind);
  }
};

// For the tests (test/chrome.mjs).
window.demo = { view, lean };
