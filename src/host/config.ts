import { access, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const VERSION = '0.1.0';
export const HELP = `pi-durable — personal terminal host for Pi Durable 1.3.0

Usage: pi-durable [options] [prompt]

No prompt opens interactive chat. There is one chat, and it never ends:
every launch, from any directory, reopens it. Tools run in the directory
you launch from (or --cwd).

  -p, --print TEXT       Send one prompt, print its answer, exit
  --resume               Finish interrupted work, print transcript, exit
  --history              Print saved user/assistant messages; run no work
  --status               Print database and pending-work status; run no work
  --database PATH        Explicit SQLite file instead of the one global chat
  --data-dir PATH        State root (or PI_DURABLE_DATA_DIR)
  --cwd PATH             Working directory (default: current directory)
  --model PROVIDER/ID    Default: openai-codex/gpt-6.1-sol
  --thinking LEVEL       off|minimal|low|medium|high|xhigh|max (default: high)
  --allow-tools          Enable read/write/edit/bash with your user privileges
  --auth-file PATH       Pi-compatible credentials (default: Pi auth.json)
  --request-id ID        Deduplicate a one-shot prompt, including after restart
  -h, --help             Show this help
  -v, --version          Show host version

Models: openai-codex/... (default, Pi login); claude-cli/opus, claude-cli/sonnet,
claude-cli/haiku, claude-cli/fable (your Claude plan, through the official claude
CLI signed in with claude auth login); anthropic/claude-sonnet-5-5 and other
anthropic/... models with an API key in ANTHROPIC_API_KEY (never a subscription
login). See docs/models.md.

Chat commands: /help, /history, /agents, /status, /exit
Ctrl+C or /exit closes the host; unfinished work resumes next launch.
No background daemon, boot service, inbound listener, or approval guards.
Tools are OFF unless --allow-tools is supplied on this launch.
`;

export function parseArgs(args) {
  const options = { thinkingLevel: 'high', allowTools: false };
  const prompts = [];
  const values = {
    '--database': 'database', '--data-dir': 'dataDir',
    '--cwd': 'cwd', '--model': 'modelSpec', '--thinking': 'thinkingLevel',
    '--auth-file': 'authFile', '--request-id': 'requestId', '--print': 'prompt', '-p': 'prompt',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { prompts.push(...args.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--allow-tools') options.allowTools = true;
    else if (['--resume', '--history', '--status'].includes(arg)) options[arg.slice(2)] = true;
    else if (values[arg]) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[values[arg]] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else prompts.push(arg);
  }
  if (options.help || options.version) return options;
  if (prompts.length && options.prompt !== undefined) throw new Error('Use either --print or a positional prompt, not both');
  if (prompts.length) options.prompt = prompts.join(' ');
  if (options.prompt !== undefined && !options.prompt.trim()) throw new Error('Prompt cannot be empty');
  if (options.requestId !== undefined && (!options.requestId.trim() || options.prompt === undefined)) throw new Error('--request-id requires a nonempty ID and a one-shot prompt');
  const modes = [options.resume, options.history, options.status, options.prompt !== undefined].filter(Boolean);
  if (modes.length > 1) throw new Error('Choose only one of --resume, --history, --status, or a prompt');
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.thinkingLevel)) throw new Error('Invalid --thinking level');
  const spec = options.modelSpec ?? process.env.PI_DURABLE_MODEL ?? 'openai-codex/gpt-6.1-sol';
  const slash = spec.indexOf('/');
  if (slash < 1 || slash === spec.length - 1) throw new Error('--model must be PROVIDER/MODEL_ID');
  options.model = { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
  return options;
}

export async function resolveOptions(options, env = process.env) {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const dataDir = resolve(options.dataDir ?? env.PI_DURABLE_DATA_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-durable'));
  let databasePath = resolve(options.database ?? join(dataDir, 'chat.sqlite'));
  let exists = false;
  try { await access(databasePath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const inspectOnly = Boolean(options.status || options.history);
  if (exists) databasePath = await realpath(databasePath);
  else if (!inspectOnly) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    databasePath = join(await realpath(dirname(databasePath)), databasePath.split('/').at(-1));
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  // The chat's memory (log, tree, view) lives beside its database, under its flock.
  const memoryDir = databasePath.replace(/(\.sqlite)?$/, '.unii');
  return { ...options, cwd, dataDir, databasePath, memoryDir, exists, inspectOnly,
    authFile: resolve(options.authFile ?? join(agentDir, 'auth.json')) };
}
