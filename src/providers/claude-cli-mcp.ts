import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isRecord } from '../protocol/util.ts';

/**
 * Stub stdio MCP server for the claude-cli provider: `node claude-cli-mcp.ts TOOLS.json`. It lists Pi's tools so
 * Claude can propose calls to them natively, and never runs anything: the provider stops the CLI at the first
 * tool_use and the Pi Harness executes the call. A call that still arrives gets DEFERRED back.
 */
const DEFERRED = 'deferred to host';

type Json = Record<string, unknown>;
const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** JSON-RPC 2.0, as far as this server reads and writes it. A request without an id is a notification. */
type Id = string | number | null;
interface Request { id?: Id; method: unknown; params: unknown }
interface McpTool { name: unknown; description: unknown; inputSchema: unknown }
type Result =
  | { protocolVersion: string; capabilities: { tools: Json }; serverInfo: { name: string; version: string } }
  | Record<string, never>
  | { tools: McpTool[] }
  | { content: { type: 'text'; text: string }[] };
type Response = { jsonrpc: '2.0'; id: Id } & ({ result: Result } | { error: { code: number; message: string } });

function parseRequest(line: string): Request | undefined {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(message)) return undefined;
  const { id, method, params } = message;
  return { id: typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined, method, params };
}

const file = process.argv[2];
if (!file) throw new Error('usage: node claude-cli-mcp.ts TOOLS.json');
const list: unknown = JSON.parse(readFileSync(file, 'utf8'));
if (!isList(list)) throw new Error(`${file}: not a list of tools`);
const tools: McpTool[] = list.filter(isRecord).map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
const send = (response: Response) => process.stdout.write(`${JSON.stringify(response)}\n`);
const methods: Partial<Record<string, (params: unknown) => Result>> = {
  initialize: params => ({ protocolVersion: isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'pi', version: '1.0.0' } }),
  ping: () => ({}),
  'tools/list': () => ({ tools }),
  'tools/call': () => ({ content: [{ type: 'text', text: DEFERRED }] }),
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = parseRequest(line);
  if (message?.id === undefined) continue; // notifications need no answer
  const method = typeof message.method === 'string' ? methods[message.method] : undefined;
  if (method) send({ jsonrpc: '2.0', id: message.id, result: method(message.params) });
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
}
