import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { atomicWrite } from '../memory/util.ts';

export const VERSION = '0.1.0';
export const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
export const DEFAULT_PORT = 7433;
export const HELP = `pi-durable — personal terminal host for Pi Durable 1.3.0

Usage: pi-durable [options] [prompt]
       pi-durable serve [--cwd DIR] [--port N]   Run the chat as a server
       pi-durable serve pair                     One-time code to pair a web device
       pi-durable serve devices [--revoke NAME]  List paired web devices, or revoke one
       pi-durable backup [--out DIR]             Online backup of the chat

No prompt opens interactive chat. There is one chat, and it never ends:
every launch, from any directory, reopens it. Tools run in the directory
you launch from (or --cwd). When a server runs for the chat, interactive
chat attaches to it instead (the server's model, tools and directory apply).
A prompt whose first word is serve or backup needs -p.

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
  --thinking LEVEL       Reasoning effort: off|minimal|low|medium|high|xhigh|max.
                         Without it: the last /effort choice (settings.json),
                         else high
  --no-tools             Turn read/write/edit/bash off for this launch (they are
                         on by default, with your user privileges)
  --allow-tools          Tools on (the default for a local launch; kept for scripts)
  --plain                Line-by-line chat instead of the full-screen terminal UI
  --local                Never attach to a server; open the chat here
  --attach               Attach to the running server, or fail
  --port N               serve: loopback TCP port for the web app (default 7433)
  --revoke NAME          serve devices: forget a device and disconnect it
  --out DIR              backup: where to write it (default: backups/ beside the chat)
  --auth-file PATH       Pi-compatible credentials (default: Pi auth.json)
  --request-id ID        Deduplicate a one-shot prompt, including after restart
  -h, --help             Show this help
  -v, --version          Show host version

Models: openai-codex/... (default, Pi login); claude-cli/opus, claude-cli/sonnet,
claude-cli/haiku, claude-cli/fable (your Claude plan, through the official claude
CLI signed in with claude auth login); anthropic/claude-sonnet-5-5 and other
anthropic/... models with an API key in ANTHROPIC_API_KEY (never a subscription
login). See docs/models.md.

Chat commands: /help, /model, /effort, /tools, /agents, /mem, /status, /exit (--plain:
/help, /history, /agents, /status, /exit). Ctrl+D or /exit closes the host, and
so does Ctrl+C (twice in the terminal UI); unfinished work resumes next launch.
Attached, they detach and the server keeps working.
Tools are ON for a local launch unless --no-tools is supplied; /tools turns them
on or off until the host exits, never for later launches. A server always starts
with them off; a client may turn them on after a confirmation, and they turn
off again after PI_DURABLE_TOOLS_IDLE_MIN idle minutes.
No approval guards. Without serve: no daemon and no listener. A server listens
only on a 0600 Unix socket beside the chat and on loopback TCP (for tailscale
serve), never on a public address.

Server environment:
  PI_DURABLE_ORIGIN          The web app's origin, e.g. https://host.tailnet.ts.net
  PI_DURABLE_ALLOW_LOGIN     Comma-separated Tailscale logins allowed in (without
                             this and PI_DURABLE_ORIGIN: socket only, no web)
  PI_DURABLE_PORT            Default for --port
  PI_DURABLE_REMOTE_TOOLS    confirm (default): the web may turn tools on after a
                             confirmation; off: only terminal clients may
  PI_DURABLE_TOOLS_IDLE_MIN  Idle minutes before tools turn off (default 30)
  PI_DURABLE_PUSH_PREVIEW    on: push notifications show the reply's first words;
                             off (default): only that Pi or an agent finished
`;

type Flag = 'help' | 'version' | 'allowTools' | 'noTools' | 'resume' | 'history' | 'status' | 'plain' | 'local' | 'attach';
type Value = 'database' | 'dataDir' | 'cwd' | 'modelSpec' | 'thinkingLevel' | 'authFile' | 'requestId' | 'prompt'
  | 'portSpec' | 'revoke' | 'out';
const FLAGS = new Map<string, Flag>([['--help', 'help'], ['-h', 'help'], ['--version', 'version'], ['-v', 'version'],
  ['--allow-tools', 'allowTools'], ['--no-tools', 'noTools'], ['--resume', 'resume'], ['--history', 'history'], ['--status', 'status'], ['--plain', 'plain'],
  ['--local', 'local'], ['--attach', 'attach']]);
const VALUES = new Map<string, Value>([
  ['--database', 'database'], ['--data-dir', 'dataDir'],
  ['--cwd', 'cwd'], ['--model', 'modelSpec'], ['--thinking', 'thinkingLevel'],
  ['--auth-file', 'authFile'], ['--request-id', 'requestId'], ['--print', 'prompt'], ['-p', 'prompt'],
  ['--port', 'portSpec'], ['--revoke', 'revoke'], ['--out', 'out'],
]);

/**
 * What a launch does: `chat` is every launch without a subcommand (interactive chat, a prompt, --status, …);
 * `serve` runs the server; `serve-pair`, `serve-devices` and `backup` are its admin commands.
 */
export type Command = 'chat' | 'serve' | 'serve-pair' | 'serve-devices' | 'backup';
const COMMANDS: readonly Command[] = ['chat', 'serve', 'serve-pair', 'serve-devices', 'backup'];
type Key = Flag | Value;
const LOCATION: readonly Key[] = ['help', 'version', 'database', 'dataDir'];
/** The options each command takes; any other is an error. A prompt is the `prompt` key. */
const ALLOWED: Readonly<Record<Command, ReadonlySet<Key>>> = {
  chat: new Set<Key>([...LOCATION, 'allowTools', 'noTools', 'resume', 'history', 'status', 'plain', 'local', 'attach', 'cwd',
    'modelSpec', 'thinkingLevel', 'authFile', 'requestId', 'prompt']),
  serve: new Set<Key>([...LOCATION, 'cwd', 'portSpec', 'modelSpec', 'thinkingLevel', 'authFile']),
  'serve-pair': new Set<Key>(LOCATION),
  'serve-devices': new Set<Key>([...LOCATION, 'revoke']),
  backup: new Set<Key>([...LOCATION, 'out']),
};
/** Options that set up a local launch, so an attached chat (which uses the server's) refuses them. */
const LAUNCH_ONLY: readonly Key[] = ['allowTools', 'noTools', 'cwd', 'modelSpec', 'thinkingLevel', 'authFile', 'plain'];
const COMMAND_NAMES: Readonly<Record<Command, string>> = {
  chat: 'chat', serve: 'serve', 'serve-pair': 'serve pair', 'serve-devices': 'serve devices', backup: 'backup',
};
/** Every reasoning effort (thinking level), lowest first. */
export const THINKING: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const isThinkingLevel = (x: unknown): x is ModelThinkingLevel => THINKING.some(level => level === x);
const DEFAULT_THINKING: ModelThinkingLevel = 'high';

/** Where the launch's model came from, highest precedence first. */
export type ModelSource = 'flag' | 'env' | 'settings' | 'default';
const MODEL_SOURCES: readonly ModelSource[] = ['flag', 'env', 'settings', 'default'];

/** Parsed command line. `model` is the --model flag's; resolveOptions() applies the other sources. */
export interface Options {
  command: Command;
  help?: boolean;
  version?: boolean;
  /** Coding tools for this launch: on for a local chat unless --no-tools; always off for serve and admin commands. */
  allowTools: boolean;
  /** --no-tools was given. */
  noTools?: boolean;
  resume?: boolean;
  history?: boolean;
  status?: boolean;
  /** Interactive chat as readline lines instead of the terminal UI. */
  plain?: boolean;
  /** Never attach to a running server. */
  local?: boolean;
  /** Attach to the running server, or fail. */
  attach?: boolean;
  /** The first launch setting given (e.g. "--model"): an attach refuses it, since the server's settings apply. */
  launchOption?: string;
  database?: string;
  dataDir?: string;
  cwd?: string;
  modelSpec?: string;
  /** --thinking's level, else the default until resolveOptions() applies settings.json. */
  thinkingLevel: ModelThinkingLevel;
  /** --thinking was given. */
  thinkingFlag?: boolean;
  authFile?: string;
  requestId?: string;
  prompt?: string;
  model?: ModelRef;
  /** --port as given, and as a number. */
  portSpec?: string;
  port?: number;
  /** `serve devices --revoke NAME`. */
  revoke?: string;
  /** `backup --out DIR`. */
  out?: string;
}

/** What `serve` reads from its environment (and --port); see HELP. */
export interface ServeSettings {
  /** Loopback TCP port of the web listener. */
  readonly port: number;
  /** PI_DURABLE_ORIGIN, normalized; the web listener runs only with it and `allowLogins`. */
  readonly origin?: string;
  /** PI_DURABLE_ALLOW_LOGIN: Tailscale logins (`Tailscale-User-Login`) let in. Empty: no web listener. */
  readonly allowLogins: readonly string[];
  /** PI_DURABLE_REMOTE_TOOLS. */
  readonly remoteTools: 'confirm' | 'off';
  /** PI_DURABLE_TOOLS_IDLE_MIN: the tools turn off after this many minutes without a run. */
  readonly toolsIdleMinutes: number;
  /** PI_DURABLE_PUSH_PREVIEW: push notifications carry the reply's first words. */
  readonly pushPreview: boolean;
}

/** The files a chat keeps beside its database (`statePaths`). Only the host or server under the flock writes them. */
export interface StatePaths {
  /** The flock target: `<db>.lock`. */
  readonly lock: string;
  /** The UniiChat memory: `chat.sqlite` → `chat.unii`. */
  readonly memoryDir: string;
  readonly settings: string;
  /**
   * The server's Unix socket (mode 600): `<db>.sock`, or, when that is over 107 bytes (the sun_path limit),
   * `$XDG_RUNTIME_DIR/pi-durable-<hash>.sock`; undefined when it is too long and XDG_RUNTIME_DIR is unset.
   */
  readonly socket: string | undefined;
  /** The server's state directory (mode 700): `serve/` beside the database. */
  readonly serveDir: string;
  /** VAPID key pair for Web Push. */
  readonly vapid: string;
  /** Web Push subscriptions. */
  readonly push: string;
  /** Paired web devices: names and sha256 of their cookies. */
  readonly devices: string;
}

/** Resolved launch configuration: what src/cli.ts passes to src/host/host.ts as JSON. */
export interface Config extends Options {
  cwd: string;
  dataDir: string;
  databasePath: string;
  memoryDir: string;
  /** The host's saved choices (settings.json), beside the database. */
  settingsPath: string;
  /** statePaths().socket: where a server listens and an interactive launch probes. */
  socketPath?: string;
  /** statePaths().serveDir. */
  serveDir: string;
  /** Only for `serve`. */
  serve?: ServeSettings;
  exists: boolean;
  inspectOnly: boolean;
  authFile: string;
  model: ModelRef;
  modelSource: ModelSource;
}

/** What settings.json holds: the defaults for launches without --model (or PI_DURABLE_MODEL) and --thinking. */
export interface Settings {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const errorCode = (error: unknown): unknown => error instanceof Error && 'code' in error ? error.code : undefined;

/** The subcommand that `words` (the positionals before any `--`) start with, and the words left after it. */
function command(words: readonly string[]): { command: Command; rest: readonly string[] } {
  const [first, second] = words;
  if (first === 'backup') return { command: 'backup', rest: words.slice(1) };
  if (first !== 'serve') return { command: 'chat', rest: words };
  if (second === 'pair') return { command: 'serve-pair', rest: words.slice(2) };
  if (second === 'devices') return { command: 'serve-devices', rest: words.slice(2) };
  return { command: 'serve', rest: words.slice(1) };
}

/** A TCP port, 1 to 65535; `what` names the source in the error. */
export function parsePort(spec: string, what: string): number {
  const port = /^\d{1,5}$/.test(spec) ? Number(spec) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`${what} must be a port number from 1 to 65535`);
  return port;
}

export function parseArgs(args: readonly string[]): Options {
  const options: Options = { command: 'chat', thinkingLevel: DEFAULT_THINKING, allowTools: true };
  const words: string[] = [], literal: string[] = [];
  const given = new Map<Key, string>();
  let thinking: string = options.thinkingLevel;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const flag = FLAGS.get(arg), key = VALUES.get(arg);
    if (arg === '--') { literal.push(...args.slice(i + 1)); break; }
    if (flag) { options[flag] = true; given.set(flag, arg); }
    else if (key) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      given.set(key, arg);
      if (key === 'thinkingLevel') { thinking = value; options.thinkingFlag = true; }
      else options[key] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  if (options.help || options.version) return options;
  const { command: chosen, rest } = command(words);
  options.command = chosen;
  const prompts = [...rest, ...literal];
  if (chosen !== 'chat') {
    const name = COMMAND_NAMES[chosen];
    if (prompts.length) {
      throw new Error(`Unknown ${name} argument: ${prompts[0] ?? ''}${chosen === 'serve' ? ' (to send a prompt starting with "serve", use -p)' : ''}`);
    }
    if (chosen === 'serve' && given.has('allowTools')) {
      throw new Error('serve always starts with coding tools off; a client turns them on with /tools on, after a confirmation');
    }
    for (const [key, spelling] of given) if (!ALLOWED[chosen].has(key)) throw new Error(`${spelling} does not apply to ${name}`);
    options.allowTools = false;
  } else {
    if (given.has('allowTools') && options.noTools) throw new Error('Choose either --allow-tools or --no-tools');
    options.allowTools = !options.noTools;
    for (const key of ['portSpec', 'revoke', 'out'] as const) {
      const spelling = given.get(key);
      if (spelling) throw new Error(`${spelling} applies only to ${key === 'portSpec' ? 'serve' : key === 'revoke' ? 'serve devices' : 'backup'}`);
    }
    if (options.local && options.attach) throw new Error('Choose either --local or --attach');
    const local = LAUNCH_ONLY.map(key => given.get(key)).find(spelling => spelling !== undefined);
    if (local && options.attach) throw new Error(`${local} does not apply to --attach: the server's settings apply (use /model and /tools there)`);
    if (local) options.launchOption = local;
  }
  if (options.portSpec !== undefined) options.port = parsePort(options.portSpec, '--port');
  if (options.revoke !== undefined && !options.revoke.trim()) throw new Error('--revoke requires a device name');
  if (prompts.length && options.prompt !== undefined) throw new Error('Use either --print or a positional prompt, not both');
  if (prompts.length) options.prompt = prompts.join(' ');
  if (options.prompt !== undefined && !options.prompt.trim()) throw new Error('Prompt cannot be empty');
  if (options.requestId !== undefined && (!options.requestId.trim() || options.prompt === undefined)) throw new Error('--request-id requires a nonempty ID and a one-shot prompt');
  const modes = [options.resume, options.history, options.status, options.prompt !== undefined].filter(Boolean);
  if (modes.length > 1) throw new Error('Choose only one of --resume, --history, --status, or a prompt');
  if (options.attach && modes.length) throw new Error('--attach is for interactive chat only');
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
  if (!isRecord(value) || (value.model !== undefined && typeof value.model !== 'string')
    || (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel))) {
    throw new Error(`${path} must be an object like {"model":"PROVIDER/MODEL_ID","thinkingLevel":"high"}; fix or delete it`);
  }
  return { ...value.model === undefined ? {} : { model: parseModel(value.model, `"model" in ${path}`) },
    ...isThinkingLevel(value.thinkingLevel) ? { thinkingLevel: value.thinkingLevel } : {} };
}

/** Replace settings.json atomically (mode 600). Only work launches write it, under the database's flock. */
export function writeSettings(path: string, { model, thinkingLevel }: Settings): void {
  const json = { ...model ? { model: `${model.provider}/${model.modelId}` } : {}, ...thinkingLevel ? { thinkingLevel } : {} };
  atomicWrite(path, `${JSON.stringify(json, null, 2)}\n`);
}

/** Change some of settings.json, keeping the rest. */
export async function updateSettings(path: string, change: Settings): Promise<void> {
  writeSettings(path, { ...await readSettings(path), ...change });
}

/**
 * The launch's model: --model, else PI_DURABLE_MODEL, else settings.json, else the built-in default. Its thinking
 * level: --thinking, else settings.json, else high.
 */
async function resolveModel(options: Options, env: NodeJS.ProcessEnv, settingsPath: string):
  Promise<{ model: ModelRef; modelSource: ModelSource; thinkingLevel: ModelThinkingLevel }> {
  // With --model, a broken settings.json must not stop the launch: it then only loses the saved thinking level.
  const saved: Settings = options.model ? options.thinkingFlag ? {} : await readSettings(settingsPath).catch(() => ({}))
    : await readSettings(settingsPath);
  const thinkingLevel = options.thinkingFlag ? options.thinkingLevel : saved.thinkingLevel ?? DEFAULT_THINKING;
  if (options.model) return { model: options.model, modelSource: 'flag', thinkingLevel };
  if (env.PI_DURABLE_MODEL) return { model: parseModel(env.PI_DURABLE_MODEL, 'PI_DURABLE_MODEL'), modelSource: 'env', thinkingLevel };
  return saved.model ? { model: saved.model, modelSource: 'settings', thinkingLevel }
    : { model: parseModel(DEFAULT_MODEL, 'the default model'), modelSource: 'default', thinkingLevel };
}

/** Longest Unix socket path: sun_path is 108 bytes on Linux, its NUL included. */
export const SOCKET_PATH_MAX = 107;

/**
 * Every file a chat keeps beside its database `databasePath` (resolved, symlinks included). One function, so the
 * host, the server, the attaching client and the backup agree. Reads `XDG_RUNTIME_DIR` from `env` for the socket.
 */
export function statePaths(databasePath: string, env: NodeJS.ProcessEnv = process.env): StatePaths {
  const dir = dirname(databasePath), serveDir = join(dir, 'serve');
  let socket: string | undefined = `${databasePath}.sock`;
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    // XDG_RUNTIME_DIR is the user's own (mode 700), so no one else can squat the name; /tmp would not be.
    const hash = createHash('sha256').update(databasePath).digest('hex').slice(0, 16);
    socket = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, `pi-durable-${hash}.sock`) : undefined;
    if (socket && Buffer.byteLength(socket) > SOCKET_PATH_MAX) socket = undefined;
  }
  return {
    lock: `${databasePath}.lock`,
    // The chat's memory (log, tree, view) lives beside its database, under its flock.
    memoryDir: databasePath.replace(/(\.sqlite)?$/, '.unii'),
    // Beside the database, under its flock; read here, written only by a work launch's /model.
    settings: join(dir, 'settings.json'),
    socket,
    serveDir,
    vapid: join(serveDir, 'vapid.json'),
    push: join(serveDir, 'push.json'),
    devices: join(serveDir, 'devices.json'),
  };
}

/** `serve`'s settings from --port and the environment; rejects a malformed variable by name. */
export function serveSettings(options: Pick<Options, 'port'>, env: NodeJS.ProcessEnv = process.env): ServeSettings {
  const port = options.port ?? (env.PI_DURABLE_PORT ? parsePort(env.PI_DURABLE_PORT, 'PI_DURABLE_PORT') : DEFAULT_PORT);
  const allowLogins = (env.PI_DURABLE_ALLOW_LOGIN ?? '').split(',').map(login => login.trim()).filter(Boolean);
  if (env.PI_DURABLE_ALLOW_LOGIN?.trim() && allowLogins.some(login => /\s/.test(login))) {
    throw new Error('PI_DURABLE_ALLOW_LOGIN must be Tailscale logins separated by commas');
  }
  const remoteTools = env.PI_DURABLE_REMOTE_TOOLS || 'confirm';
  if (remoteTools !== 'confirm' && remoteTools !== 'off') throw new Error('PI_DURABLE_REMOTE_TOOLS must be confirm or off');
  const idle = env.PI_DURABLE_TOOLS_IDLE_MIN || '30';
  const toolsIdleMinutes = /^\d{1,4}$/.test(idle) ? Number(idle) : NaN;
  if (!(toolsIdleMinutes >= 1 && toolsIdleMinutes <= 1440)) throw new Error('PI_DURABLE_TOOLS_IDLE_MIN must be minutes from 1 to 1440');
  const preview = env.PI_DURABLE_PUSH_PREVIEW || 'off';
  if (preview !== 'on' && preview !== 'off') throw new Error('PI_DURABLE_PUSH_PREVIEW must be on or off');
  const settings: ServeSettings = { port, allowLogins, remoteTools, toolsIdleMinutes, pushPreview: preview === 'on' };
  return env.PI_DURABLE_ORIGIN ? { ...settings, origin: parseOrigin(env.PI_DURABLE_ORIGIN) } : settings;
}

/** An origin (scheme, host, port; no path): https, or http on a loopback host for development. */
function parseOrigin(value: string): string {
  const problem = 'PI_DURABLE_ORIGIN must be an origin like https://host.tailnet.ts.net (no path)';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(problem); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value.replace(/\/$/, '') || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error(problem);
  }
  return url.origin;
}

export async function resolveOptions(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const dataDir = resolve(options.dataDir ?? env.PI_DURABLE_DATA_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-durable'));
  let databasePath = resolve(options.database ?? join(dataDir, 'chat.sqlite'));
  let exists = false;
  try { await access(databasePath); exists = true; } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const inspectOnly = Boolean(options.status || options.history);
  // Only work launches and serve create the chat; inspection and the admin commands never do.
  const creates = !inspectOnly && (options.command === 'chat' || options.command === 'serve');
  if (exists) databasePath = await realpath(databasePath);
  else if (creates) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    databasePath = join(await realpath(dirname(databasePath)), basename(databasePath));
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const paths = statePaths(databasePath, env);
  const serve = options.command === 'serve' ? { serve: serveSettings(options, env) } : {};
  return { ...options, ...await resolveModel(options, env, paths.settings), cwd, dataDir, databasePath,
    memoryDir: paths.memoryDir, settingsPath: paths.settings, ...paths.socket ? { socketPath: paths.socket } : {},
    serveDir: paths.serveDir, ...serve, exists, inspectOnly, authFile: resolve(options.authFile ?? join(agentDir, 'auth.json')) };
}

const STRINGS = ['cwd', 'dataDir', 'databasePath', 'memoryDir', 'settingsPath', 'serveDir', 'authFile'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_STRINGS = ['database', 'modelSpec', 'requestId', 'prompt', 'socketPath', 'portSpec', 'revoke', 'out', 'launchOption'] as const satisfies readonly (keyof Config)[];
const BOOLEANS = ['allowTools', 'exists', 'inspectOnly'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_BOOLEANS = ['help', 'version', 'noTools', 'resume', 'history', 'status', 'plain', 'local', 'attach', 'thinkingFlag'] as const satisfies readonly (keyof Config)[];
const isPort = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535;

function isServeSettings(x: unknown): x is ServeSettings {
  return isRecord(x) && isPort(x.port) && (x.origin === undefined || typeof x.origin === 'string')
    && Array.isArray(x.allowLogins) && x.allowLogins.every(login => typeof login === 'string')
    && (x.remoteTools === 'confirm' || x.remoteTools === 'off')
    && typeof x.toolsIdleMinutes === 'number' && Number.isInteger(x.toolsIdleMinutes) && x.toolsIdleMinutes >= 1
    && typeof x.pushPreview === 'boolean';
}
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function isConfig(x: unknown): x is Config {
  if (!isRecord(x) || !isRecord(x.model)) return false;
  return typeof x.model.provider === 'string' && typeof x.model.modelId === 'string' && isThinkingLevel(x.thinkingLevel)
    && MODEL_SOURCES.some(source => source === x.modelSource) && COMMANDS.some(command => command === x.command)
    && (x.port === undefined || isPort(x.port)) && (x.serve === undefined || isServeSettings(x.serve))
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
