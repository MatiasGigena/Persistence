// NDJSON framing: the Unix socket, the SSH bridge and the admin commands carry one message per line. Works on text,
// so each side decodes its bytes first (a Node stream with setEncoding('utf8') keeps a character split across chunks
// whole); no Node or DOM imports, like the rest of src/protocol/.

/**
 * Splits a text stream into lines: `line` gets each nonblank one without its newline (or `\r\n`); a line longer than
 * `max` code units is skipped up to its newline, and `tooLong` is called once for it instead.
 */
export function lineSplitter(max: number, line: (text: string) => void, tooLong: () => void = () => undefined): (chunk: string) => void {
  let partial = '', skipping = false;
  return chunk => {
    let text = chunk;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n')) {
      const head = text.slice(0, at);
      text = text.slice(at + 1);
      if (skipping) { skipping = false; partial = ''; continue; }
      const whole = (partial + head).replace(/\r$/, '');
      partial = '';
      if (whole.length > max) tooLong();
      else if (whole.trim()) line(whole);
    }
    if (skipping) return;
    partial += text;
    if (partial.length > max) { partial = ''; skipping = true; tooLong(); }
  };
}
