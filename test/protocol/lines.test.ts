import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineSplitter } from '../../src/protocol/lines.ts';

test('lineSplitter splits lines across chunks and skips an oversized one', () => {
  const lines: string[] = [];
  let tooLong = 0;
  const split = lineSplitter(5, line => lines.push(line), () => tooLong++);
  for (const chunk of ['ab', 'c\nde', 'f\r\n\n', '123456', '789\nok\n', 'x'.repeat(9), '\n', '€\n']) split(chunk);
  assert.deepEqual(lines, ['abc', 'def', 'ok', '€']);
  assert.equal(tooLong, 2);
});
