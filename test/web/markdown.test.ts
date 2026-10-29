import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, safeHref } from '../../src/web/markdown.ts';

test('raw HTML is escaped, block and inline', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> <b>bold</b>');
  assert.ok(!/<script|<img|<b>/i.test(html), html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('links keep only http(s) and mailto, and open safely', () => {
  const ok = renderMarkdown('[a](https://example.com/x?y=1&z=2 "T") [m](mailto:me@example.com)');
  assert.match(ok, /<a href="https:\/\/example.com\/x\?y=1&amp;z=2" title="T" target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.match(ok, /href="mailto:me@example.com"/);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:x', '/relative', '//evil.com']) {
    const html = renderMarkdown(`[x](${bad})`);
    assert.ok(!html.includes('<a'), `${bad}: ${html}`);
    assert.match(html, /x/);
  }
  assert.equal(safeHref(' https://a.b '), 'https://a.b/');
  assert.equal(safeHref('javascript:void(0)'), undefined);
});

test('autolinks get the same treatment', () => {
  assert.match(renderMarkdown('see https://example.com now'), /<a href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer">/);
  assert.match(renderMarkdown('<https://example.com>'), /rel="noopener noreferrer"/);
});

test('images become links, never <img>', () => {
  const html = renderMarkdown('![a cat](https://example.com/cat.png) ![x](javascript:alert(1))');
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /<a href="https:\/\/example.com\/cat.png" target="_blank" rel="noopener noreferrer">a cat \(image\)<\/a>/);
  assert.ok(!html.includes('javascript:'), html);
});

test('code is escaped, attributes cannot be broken out of', () => {
  const html = renderMarkdown('```js" onclick="x\n<div>\n```\n\n`<i>`');
  assert.ok(!html.includes('<div>') && !html.includes('<i>'), html);
  assert.ok(!/onclick="x/.test(html), html);
  const title = renderMarkdown('[a](https://e.com "x\\" onmouseover=\\"y")');
  assert.ok(!/" onmouseover=/.test(title), title);
});

test('ordinary Markdown renders', () => {
  const html = renderMarkdown('# Title\n\n**bold** _em_ ~~del~~\n\n- one\n- two\n\n| a | b |\n|---|:-:|\n| 1 | 2 |');
  for (const tag of ['<h1>', '<strong>', '<em>', '<del>', '<ul>', '<table>']) assert.ok(html.includes(tag), `${tag} in ${html}`);
  assert.ok(!html.includes('style='), html);
});

test('task list items are marked, so they show their checkbox without a bullet too', () => {
  const tight = renderMarkdown('- [x] done\n- [ ] open\n- plain');
  assert.match(tight, /<li class="task"><input checked="" disabled="" type="checkbox"> done<\/li>/);
  assert.match(tight, /<li class="task"><input disabled="" type="checkbox"> open<\/li>/);
  assert.match(tight, /<li>plain<\/li>/);
  const loose = renderMarkdown('- [x] one\n\n- [ ] two');
  assert.match(loose, /<li class="task"><p><input checked="" disabled="" type="checkbox"> one<\/p>/);
});
