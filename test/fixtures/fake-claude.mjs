#!/usr/bin/env node
// A stand-in for the `claude` CLI (PI_DURABLE_CLAUDE_BIN). Every call appends { argv, stdin, cwd, env, system, mcp,
// tools } to FAKE_CLAUDE_LOG, reading the system prompt and tool files now (the provider deletes them later); a
// SIGTERM appends { killed: true }. `auth status` prints FAKE_CLAUDE_AUTH. A print-mode call plays the n-th entry of
// the JSON array in FAKE_CLAUDE_SCRIPT: { lines: [stream-json objects], stderr, exit }; without `exit` it then waits
// to be killed, like a CLI about to act on its reply.
import { appendFileSync, readFileSync } from 'node:fs';

const log = process.env.FAKE_CLAUDE_LOG;
const record = entry => appendFileSync(log, `${JSON.stringify(entry)}\n`);
const argv = process.argv.slice(2);
const env = Object.fromEntries(['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'HOME']
  .map(name => [name, process.env[name] ?? null]));

if (argv[0] === 'auth') {
  record({ argv, env });
  process.stdout.write(process.env.FAKE_CLAUDE_AUTH ?? '{"loggedIn":false}');
  process.exit(0);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const calls = readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"argv":["-p"')).length;
const after = flag => argv[argv.indexOf(flag) + 1];
const system = argv.includes('--system-prompt-file') ? readFileSync(after('--system-prompt-file'), 'utf8') : null;
const mcp = argv.includes('--mcp-config') ? JSON.parse(after('--mcp-config')) : null;
const tools = mcp ? JSON.parse(readFileSync(mcp.mcpServers.pi.args[1], 'utf8')) : null;
record({ argv, stdin, cwd: process.cwd(), env, system, mcp, tools });
process.on('SIGTERM', () => { record({ killed: true }); process.exit(143); });
const step = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'))[calls] ?? { lines: [], exit: 1, stderr: 'no scripted reply' };
for (const line of step.lines ?? []) process.stdout.write(`${JSON.stringify(line)}\n`);
if (step.stderr) process.stderr.write(step.stderr);
if (step.exit !== undefined) process.exit(step.exit);
setInterval(() => {}, 1000);
