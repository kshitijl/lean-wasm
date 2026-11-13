import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandAbbreviation, markdownBlocks, offsetToPosition, positionToOffset, toEditorDiagnostics } from '../demo/src/convert.js';

const TEXT = 'import Std.WP\ndef x := 1\n∀ y';

test('positionToOffset: line and character from 0; past the end of a line, the line end', () => {
  assert.deepEqual(
    [{ line: 0, character: 0 }, { line: 1, character: 4 }, { line: 1, character: 99 }, { line: 2, character: 2 }, { line: 9, character: 0 }]
      .map((p) => positionToOffset(TEXT, p)),
    [0, 18, 24, 27, 28]);
});

test('offsetToPosition: the inverse', () => {
  assert.deepEqual([0, 18, 24, 27].map((o) => offsetToPosition(TEXT, o)),
    [{ line: 0, character: 0 }, { line: 1, character: 4 }, { line: 1, character: 10 }, { line: 2, character: 2 }]);
});

test('toEditorDiagnostics: severities by name; an empty range is widened to one character', () => {
  const range = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  assert.deepEqual(toEditorDiagnostics(TEXT, [
    { range: range(1, 4, 1, 5), severity: 1, message: 'error' },
    { range: range(1, 4, 1, 4), severity: 2, message: 'empty, mid-line' },
    { range: range(1, 10, 1, 10), severity: 3, message: 'empty, at the line end' },
    { range: range(0, 0, 0, 6), message: 'no severity' },
  ]), [
    { from: 18, to: 19, severity: 'error', message: 'error', line: 2 },
    { from: 18, to: 19, severity: 'warning', message: 'empty, mid-line', line: 2 },
    { from: 23, to: 24, severity: 'info', message: 'empty, at the line end', line: 2 },
    { from: 0, to: 6, severity: 'error', message: 'no severity', line: 1 },
  ]);
});

test('markdownBlocks: Lean\'s hover, a signature in a fence, a rule, then the doc string', () => {
  assert.deepEqual(markdownBlocks('```lean\nmyMax (a b : Int) : Int\n```\n***\nThe larger of two integers.'), [
    { kind: 'code', text: 'myMax (a b : Int) : Int' },
    { kind: 'text', text: 'The larger of two integers.' },
  ]);
});

test('expandAbbreviation: a known name and one more character; otherwise null', () => {
  assert.deepEqual(['x \\forall ', '\\le)', '\\cdot ', '\\nosuch ', '\\forall', 'plain '].map(expandAbbreviation),
    ['x ∀ ', '≤)', '· ', null, null, null]);
});
