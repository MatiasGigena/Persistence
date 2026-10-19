// The client's side of feed sync: a feed's items rebuilt from `snapshot` and `items` messages. Shared by Node (the
// attached TUI) and the browser.
import type { AppendField, ChatItem, ItemOp } from './messages.ts';

/** `item` with `text` appended to `field`, or undefined when the field is not the item's or not `at` long. */
function appended(item: ChatItem, field: AppendField, at: number, text: string): ChatItem | undefined {
  if (item.kind === 'tool') {
    if (field === 'output') return item.output.length === at ? { ...item, output: item.output + text } : undefined;
    if (field === 'args') return item.args.length === at ? { ...item, args: item.args + text } : undefined;
    return undefined;
  }
  return field === 'text' && item.text.length === at ? { ...item, text: item.text + text } : undefined;
}

/**
 * `items` with `ops` applied in order, as messages.ts ItemOp defines them; a new list, `items` untouched, and
 * unchanged items keep their objects. 'resync' when an op does not fit what the client holds (an append whose
 * `at` differs, an unknown id or `before`): the client then asks for `feed.resync` and waits for its snapshot.
 */
export function applyOps(items: readonly ChatItem[], ops: readonly ItemOp[]): ChatItem[] | 'resync' {
  const list = [...items];
  const indexOf = (id: string): number => list.findIndex(item => item.id === id);
  for (const op of ops) {
    if (op.op === 'put') {
      const at = indexOf(op.item.id);
      if (at >= 0) { list[at] = op.item; continue; }
      if (op.before === undefined) { list.push(op.item); continue; }
      const before = indexOf(op.before);
      if (before < 0) return 'resync';
      list.splice(before, 0, op.item);
    } else if (op.op === 'append') {
      const at = indexOf(op.id), item = list[at];
      const next = item && appended(item, op.field, op.at, op.text);
      if (!next) return 'resync';
      list[at] = next;
    } else {
      const at = indexOf(op.id);
      if (at < 0) return 'resync';
      list.splice(at, 1);
    }
  }
  return list;
}
