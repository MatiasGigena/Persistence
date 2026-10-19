import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Stub stdio MCP server for the claude-cli provider: `node claude-cli-mcp.mjs TOOLS.json`. It lists Pi's tools so
 * Claude can propose calls to them natively, and never runs anything: the provider stops the CLI at the first
 * tool_use and the Pi Harness executes the call. A call that still arrives gets DEFERRED back.
 */
const DEFERRED = 'deferred to host';

const tools = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  .map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const methods = {
  initialize: params => ({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
    serverInfo: { name: 'pi', version: '1.0.0' } }),
  ping: () => ({}),
  'tools/list': () => ({ tools }),
  'tools/call': () => ({ content: [{ type: 'text', text: DEFERRED }] }),
};

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue; // notifications need no answer
  const method = methods[message.method];
  if (method) reply(message.id, method(message.params));
  else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })}\n`);
}
