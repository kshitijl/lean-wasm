// Pure conversions between Lean's language server and the editor. No I/O, no editor state.
// LSP positions count lines from 0 and characters in UTF-16 code units, as JavaScript strings
// and CodeMirror offsets do.

/** The offset in `text` of an LSP position, clamped to the line and to the text. */
export function positionToOffset(text, { line, character }) {
  let start = 0;
  for (let l = 0; l < line; l++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return text.length;
    start = next + 1;
  }
  const end = text.indexOf('\n', start);
  return Math.min(start + character, end < 0 ? text.length : end);
}

/** The LSP position of an offset in `text`. */
export function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

const SEVERITIES = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/**
 * LSP diagnostics as CodeMirror lint diagnostics. An empty range is widened to the character
 * after it (or before it, at the end of a line), so that it can be seen.
 */
export function toEditorDiagnostics(text, diagnostics) {
  return diagnostics.map((d) => {
    let from = positionToOffset(text, d.range.start);
    let to = positionToOffset(text, d.range.end);
    if (from === to) {
      if (to < text.length && text[to] !== '\n') to += 1;
      else if (from > 0 && text[from - 1] !== '\n') from -= 1;
    }
    return { from, to, severity: SEVERITIES[d.severity ?? 1], message: d.message, line: d.range.start.line + 1 };
  });
}

/**
 * Lean's hover text (Markdown) as blocks: fenced code, and text between. Enough for what Lean
 * writes: a signature in a code fence, a `***` rule (dropped), then the doc string.
 * @returns {{kind: 'code' | 'text', text: string}[]}
 */
export function markdownBlocks(markdown) {
  const blocks = [];
  const parts = markdown.replace(/^(\*\*\*|---)\s*$/gm, '').split(/^```[a-z0-9]*\n?/m);
  parts.forEach((part, i) => {
    const text = part.replace(/\n+$/, '').replace(/^\n+/, '');
    if (text !== '') blocks.push({ kind: i % 2 === 1 ? 'code' : 'text', text });
  });
  return blocks;
}

const ABBREVIATIONS = {
  forall: '∀', all: '∀', exists: '∃', ex: '∃', in: '∈', to: '→', r: '→', l: '←', and: '∧', or: '∨',
  not: '¬', neg: '¬', le: '≤', ge: '≥', ne: '≠', times: '×', x: '×', a: 'α', b: 'β', g: 'γ',
  lam: 'λ', fun: 'λ', N: 'ℕ', Z: 'ℤ', iff: '↔', cdot: '·', sub: '⊆', cup: '∪', cap: '∩',
};

/**
 * Lean's input of special characters: when `before` (the text up to the cursor) ends with a
 * backslash, a known name and one more character, the name becomes its symbol. Otherwise null.
 * `\forall ` gives `∀ `.
 */
export function expandAbbreviation(before) {
  const m = before.match(/\\([A-Za-z]+)([^A-Za-z])$/);
  if (m === null || !Object.hasOwn(ABBREVIATIONS, m[1])) return null;
  return before.slice(0, before.length - m[0].length) + ABBREVIATIONS[m[1]] + m[2];
}
