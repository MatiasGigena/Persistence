import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { atomicWrite } from '../memory/util.ts';

export const VERSION = '0.1.0';
export const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
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
  --model PROVIDER/ID    Model for this launch. Without it: PI_DURABLE_MODEL, else
                         the last /model choice (settings.json beside the
                         database), else openai-codex/gpt-6.1-sol
  --thinking LEVEL       off|minimal|low|medium|high|xhigh|max (default: high)
  --allow-tools          Enable read/write/edit/bash with your user privileges
  --plain                Line-by-line chat instead of the full-screen terminal UI
  --auth-file PATH       Pi-compatible credentials (default: Pi auth.json)
  --request-id ID        Deduplicate a one-shot prompt, including after restart
  -h, --help             Show this help
  -v, --version          Show host version

Models: openai-codex/... (default, Pi login); claude-cli/opus, claude-cli/sonnet,
claude-cli/haiku, claude-cli/fable (your Claude plan, through the official claude
CLI signed in with claude auth login); anthropic/claude-sonnet-5-5 and other
anthropic/... models with an API key in ANTHROPIC_API_KEY (never a subscription
login). See docs/models.md.

Chat commands: /help, /model, /tools, /agents, /mem, /status, /exit (--plain:
/help, /history, /agents, /status, /exit). Ctrl+D or /exit closes the host, and
so does Ctrl+C (twice in the terminal UI); unfinished work resumes next launch.
No background daemon, boot service, inbound listener, or approval guards.
Tools are OFF unless --allow-tools is supplied on this launch; /tools turns them
on or off until the host exits, never for later launches.
`;

type Flag = 'help' | 'version' | 'allowTools' | 'resume' | 'history' | 'status' | 'plain';
type Value = 'database' | 'dataDir' | 'cwd' | 'modelSpec' | 'thinkingLevel' | 'authFile' | 'requestId' | 'prompt';
const FLAGS = new Map<string, Flag>([['--help', 'help'], ['-h', 'help'], ['--version', 'version'], ['-v', 'version'],
  ['--allow-tools', 'allowTools'], ['--resume', 'resume'], ['--history', 'history'], ['--status', 'status'], ['--plain', 'plain']]);
const VALUES = new Map<string, Value>([
  ['--database', 'database'], ['--data-dir', 'dataDir'],
  ['--cwd', 'cwd'], ['--model', 'modelSpec'], ['--thinking', 'thinkingLevel'],
  ['--auth-file', 'authFile'], ['--request-id', 'requestId'], ['--print', 'prompt'], ['-p', 'prompt'],
]);
const THINKING: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const isThinkingLevel = (x: unknown): x is ModelThinkingLevel => THINKING.some(level => level === x);

/** Where the launch's model came from, highest precedence first. */
export type ModelSource = 'flag' | 'env' | 'settings' | 'default';
const MODEL_SOURCES: readonly ModelSource[] = ['flag', 'env', 'settings', 'default'];

/** Parsed command line. `model` is the --model flag's; resolveOptions() applies the other sources. */
export interface Options {
  help?: boolean;
  version?: boolean;
  allowTools: boolean;
  resume?: boolean;
  history?: boolean;
  status?: boolean;
  /** Interactive chat as readline lines instead of the terminal UI. */
  plain?: boolean;
  database?: string;
  dataDir?: string;
  cwd?: string;
  modelSpec?: string;
  thinkingLevel: ModelThinkingLevel;
  authFile?: string;
  requestId?: string;
  prompt?: string;
  model?: ModelRef;
}

/** Resolved launch configuration: what src/cli.ts passes to src/host/host.ts as JSON. */
export interface Config extends Options {
  cwd: string;
  dataDir: string;
  databasePath: string;
  memoryDir: string;
  /** The host's saved choices (settings.json), beside the database. */
  settingsPath: string;
  exists: boolean;
  inspectOnly: boolean;
  authFile: string;
  model: ModelRef;
  modelSource: ModelSource;
}

/** What settings.json holds: the default model for launches without --model or PI_DURABLE_MODEL. */
export interface Settings {
  model?: ModelRef;
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const errorCode = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;

export function parseArgs(args: readonly string[]): Options {
  const options: Options = { thinkingLevel: 'high', allowTools: false };
  const prompts: string[] = [];
  let thinking: string = options.thinkingLevel;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const flag = FLAGS.get(arg), key = VALUES.get(arg);
    if (arg === '--') { prompts.push(...args.slice(i + 1)); break; }
    if (flag) options[flag] = true;
    else if (key) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (key === 'thinkingLevel') thinking = value;
      else options[key] = value;
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
  if (!isThinkingLevel(thinking)) throw new Error('Invalid --thinking level');
  options.thinkingLevel = thinking;
  if (options.modelSpec !== undefined) options.model = parseModel(options.modelSpec, '--model');
  return options;
}

/** `PROVIDER/ID` as a ModelRef; the ID may contain slashes. `what` names the source in the error. */
export function parseModel(spec: string, what: string): ModelRef {
  const slash = spec.indexOf('/');
  if (slash < 1 || slash === spec.length - 1) throw new Error(`${what} must be PROVIDER/MODEL_ID`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** settings.json, or {} when there is none. Rejects on a file that is not valid settings. */
export async function readSettings(path: string): Promise<Settings> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${path} is not valid JSON (${errorMessage(error)}); fix or delete it`); }
  if (!isRecord(value) || (value.model !== undefined && typeof value.model !== 'string')) {
    throw new Error(`${path} must be an object like {"model":"PROVIDER/MODEL_ID"}; fix or delete it`);
  }
  return value.model === undefined ? {} : { model: parseModel(value.model, `"model" in ${path}`) };
}

/** Replace settings.json atomically (mode 600). Only work launches write it, under the database's flock. */
export function writeSettings(path: string, { model }: Settings): void {
  atomicWrite(path, `${JSON.stringify(model ? { model: `${model.provider}/${model.modelId}` } : {}, null, 2)}\n`);
}

/** The launch's model: --model, else PI_DURABLE_MODEL, else settings.json, else the built-in default. */
async function resolveModel(options: Options, env: NodeJS.ProcessEnv, settingsPath: string): Promise<{ model: ModelRef; modelSource: ModelSource }> {
  if (options.model) return { model: options.model, modelSource: 'flag' };
  if (env.PI_DURABLE_MODEL) return { model: parseModel(env.PI_DURABLE_MODEL, 'PI_DURABLE_MODEL'), modelSource: 'env' };
  const { model } = await readSettings(settingsPath);
  return model ? { model, modelSource: 'settings' } : { model: parseModel(DEFAULT_MODEL, 'the default model'), modelSource: 'default' };
}

export async function resolveOptions(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const dataDir = resolve(options.dataDir ?? env.PI_DURABLE_DATA_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-durable'));
  let databasePath = resolve(options.database ?? join(dataDir, 'chat.sqlite'));
  let exists = false;
  try { await access(databasePath); exists = true; } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const inspectOnly = Boolean(options.status || options.history);
  if (exists) databasePath = await realpath(databasePath);
  else if (!inspectOnly) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    databasePath = join(await realpath(dirname(databasePath)), basename(databasePath));
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  // The chat's memory (log, tree, view) lives beside its database, under its flock.
  const memoryDir = databasePath.replace(/(\.sqlite)?$/, '.unii');
  // Beside the database, under its flock; read here, written only by a work launch's /model.
  const settingsPath = join(dirname(databasePath), 'settings.json');
  return { ...options, ...await resolveModel(options, env, settingsPath), cwd, dataDir, databasePath, memoryDir, settingsPath,
    exists, inspectOnly, authFile: resolve(options.authFile ?? join(agentDir, 'auth.json')) };
}

const STRINGS = ['cwd', 'dataDir', 'databasePath', 'memoryDir', 'settingsPath', 'authFile'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_STRINGS = ['database', 'modelSpec', 'requestId', 'prompt'] as const satisfies readonly (keyof Config)[];
const BOOLEANS = ['allowTools', 'exists', 'inspectOnly'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_BOOLEANS = ['help', 'version', 'resume', 'history', 'status', 'plain'] as const satisfies readonly (keyof Config)[];
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function isConfig(x: unknown): x is Config {
  if (!isRecord(x) || !isRecord(x.model)) return false;
  return typeof x.model.provider === 'string' && typeof x.model.modelId === 'string' && isThinkingLevel(x.thinkingLevel)
    && MODEL_SOURCES.some(source => source === x.modelSource)
    && STRINGS.every(key => typeof x[key] === 'string') && BOOLEANS.every(key => typeof x[key] === 'boolean')
    && OPTIONAL_STRINGS.every(key => x[key] === undefined || typeof x[key] === 'string')
    && OPTIONAL_BOOLEANS.every(key => x[key] === undefined || typeof x[key] === 'boolean');
}

/** The Config of `JSON.stringify(config)`, checked. */
export function parseConfig(json: string | undefined): Config {
  const config: unknown = JSON.parse(json ?? 'null');
  if (!isConfig(config)) throw new Error('invalid host configuration');
  return config;
}
