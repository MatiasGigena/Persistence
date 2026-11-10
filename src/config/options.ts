// The command line and the resolved launch configuration: parseArgs reads argv, resolveOptions applies the environment
// and settings.json, and src/cli.ts hands the result (Config) to the host or the server as JSON.
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { DEFAULT_ROSTER, isAgentName, isKit } from '../agents/roster.ts';
import type { Roster } from '../agents/roster.ts';
import { errorCode, isRecord } from '../protocol/util.ts';
import { SDK } from '../runtime/sdk.ts';
import { isThinkingLevel, THINKING } from '../runtime/thinking.ts';
import { chromiumPath, dataDirOf, parsePort, serveSettings, statePaths } from './paths.ts';
import type { ServeSettings } from './paths.ts';
import { DEFAULT_THINKING, parseModel, readRoster, readSettings } from './settings.ts';
import type { Settings } from './settings.ts';

export const VERSION = '0.1.0';
export const DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
export const HELP = `pi-durable — terminal host for Pi Durable ${SDK}

Usage: pi-durable [options] [prompt]
       pi-durable serve [--cwd DIR] [--port N]   Run the chat as a server
       pi-durable serve pair                     One-time code to pair a web device
       pi-durable serve devices [--revoke NAME]  List paired web devices, or revoke one
       pi-durable serve agents [--archive NAME | --archive-adhoc | --restore NAME]
                                                 List agents, archive or restore them
       pi-durable backup [--out DIR]             Online backup of the chat
       pi-durable connect SSH_HOST [options]     Save the default remote server
       pi-durable bridge                        Proxy the local server socket over stdio

No prompt opens interactive chat. There is one chat, and it never ends:
every launch, from any directory, reopens it. Tools run in the directory
you launch from (or --cwd). When a server runs for the chat, interactive
chat attaches to it instead (the server's model, tools and directory apply).
A prompt whose first word is serve, backup, connect or bridge needs -p.

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
  --remote SSH_HOST      Use an SSH server for this launch (else saved remote)
  --remote-bin PATH      Remote pi-durable executable (default: pi-durable)
  --remote-data-dir PATH Remote server state directory
  --local                Bypass saved remote; open the chat here
  --attach               Attach to the running server, or fail
  --port N               serve: loopback TCP port for the web app (default 7433)
  --revoke NAME          serve devices: forget a device and disconnect it
  --archive NAME         serve agents: archive an agent (and its sub agents); it is
                         deleted a day later unless restored
  --archive-adhoc        serve agents: archive every ad-hoc main agent
  --restore NAME         serve agents: restore an archived agent
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

Chat commands: /help, /model, /effort, /tools, /agents, /mem, /schedule, /status,
/usage, /stop, /exit
(--plain: /help, /history, /agents, /status, /exit). Ctrl+D or /exit closes the host, and
so does Ctrl+C (twice in the terminal UI); unfinished work resumes next launch.
Attached, they detach and the server keeps working.
Remote machine tools are OFF unless --allow-tools is supplied for this client
launch; --no-tools keeps them off. Saved remote preferences never grant permission.
Tools are ON, for a local launch and for serve, unless --no-tools is supplied;
/tools turns them on or off until the host exits, never for later launches.
Protected folders: the chat's own state and your credentials (~/.ssh, ~/.claude,
~/.config/gh, ~/.aws, ...) are hidden from the tools, and system folders (/etc,
/usr, ...) are read-only; bash runs in bubblewrap (apt install bubblewrap) to
enforce it. PI_DURABLE_PROTECT adds hidden paths, PI_DURABLE_UNPROTECT removes
defaults (each ':'-separated, ~ allowed). Your SSH agent is hidden too:
PI_DURABLE_SSH_KEYS gives bash an agent with only those keys. No approval prompts.
Standing agents (Coder, Reviewer, Researcher; settings.json's "agents") have
their own models and tool kits; the browser kit needs Chromium (npx
playwright-core install chromium, or PI_DURABLE_CHROMIUM). See docs/agents.md.
Without serve: no daemon and no listener. A server listens
only on a 0600 Unix socket beside the chat and on loopback TCP (for tailscale
serve), never on a public address.

Server environment:
  PI_DURABLE_ORIGIN          The web app's origin, e.g. https://host.tailnet.ts.net
  PI_DURABLE_ALLOW_LOGIN     Comma-separated Tailscale logins allowed in (without
                             this and PI_DURABLE_ORIGIN: socket only, no web)
  PI_DURABLE_PORT            Default for --port
  PI_DURABLE_REMOTE_TOOLS    confirm (default): the web may turn tools on after a
                             confirmation; off: only terminal clients may
  PI_DURABLE_TOOLS_IDLE_MIN  Idle minutes before tools turn off (default off: never)
  PI_DURABLE_PUSH_PREVIEW    on: push notifications show the reply's first words;
                             off (default): only that Pi or an agent finished
  PI_DURABLE_CHROMIUM        Absolute path of the Chromium the browser tools run
                             (local launches too); default: Playwright's own
`;

type Flag = 'help' | 'version' | 'allowTools' | 'noTools' | 'resume' | 'history' | 'status' | 'plain' | 'local' | 'attach'
  | 'archiveAdhoc';
type Value = 'database' | 'dataDir' | 'cwd' | 'modelSpec' | 'thinkingLevel' | 'authFile' | 'requestId' | 'prompt'
  | 'portSpec' | 'revoke' | 'out' | 'archive' | 'restore' | 'remote' | 'remoteBin' | 'remoteDataDir';
const FLAGS = new Map<string, Flag>([['--help', 'help'], ['-h', 'help'], ['--version', 'version'], ['-v', 'version'],
  ['--allow-tools', 'allowTools'], ['--no-tools', 'noTools'], ['--resume', 'resume'], ['--history', 'history'], ['--status', 'status'], ['--plain', 'plain'],
  ['--local', 'local'], ['--attach', 'attach'], ['--archive-adhoc', 'archiveAdhoc']]);
const VALUES = new Map<string, Value>([
  ['--database', 'database'], ['--data-dir', 'dataDir'],
  ['--cwd', 'cwd'], ['--model', 'modelSpec'], ['--thinking', 'thinkingLevel'],
  ['--auth-file', 'authFile'], ['--request-id', 'requestId'], ['--print', 'prompt'], ['-p', 'prompt'],
  ['--port', 'portSpec'], ['--revoke', 'revoke'], ['--out', 'out'], ['--archive', 'archive'], ['--restore', 'restore'],
  ['--remote', 'remote'], ['--remote-bin', 'remoteBin'], ['--remote-data-dir', 'remoteDataDir'],
]);

/**
 * What a launch does: `chat` is every launch without a subcommand (interactive chat, a prompt, --status, …);
 * `serve` runs the server; `serve-pair`, `serve-devices`, `serve-agents` and `backup` are its admin commands.
 */
export type Command = 'chat' | 'serve' | 'serve-pair' | 'serve-devices' | 'serve-agents' | 'backup' | 'connect' | 'bridge';
const COMMANDS: readonly Command[] = ['chat', 'serve', 'serve-pair', 'serve-devices', 'serve-agents', 'backup', 'connect', 'bridge'];
type Key = Flag | Value;
const LOCATION: readonly Key[] = ['help', 'version', 'database', 'dataDir'];
/** The options each command takes; any other is an error. A prompt is the `prompt` key. */
const ALLOWED: Readonly<Record<Command, ReadonlySet<Key>>> = {
  chat: new Set<Key>([...LOCATION, 'allowTools', 'noTools', 'resume', 'history', 'status', 'plain', 'local', 'attach', 'cwd',
    'modelSpec', 'thinkingLevel', 'authFile', 'requestId', 'prompt', 'remote', 'remoteBin', 'remoteDataDir']),
  serve: new Set<Key>([...LOCATION, 'cwd', 'portSpec', 'modelSpec', 'thinkingLevel', 'authFile', 'allowTools', 'noTools']),
  'serve-pair': new Set<Key>(LOCATION),
  'serve-devices': new Set<Key>([...LOCATION, 'revoke']),
  'serve-agents': new Set<Key>([...LOCATION, 'archive', 'archiveAdhoc', 'restore']),
  backup: new Set<Key>([...LOCATION, 'out']),
  connect: new Set<Key>(['help', 'version', 'remoteBin', 'remoteDataDir']),
  bridge: new Set<Key>(LOCATION),
};
const COMMAND_NAMES: Readonly<Record<Command, string>> = {
  chat: 'chat', serve: 'serve', 'serve-pair': 'serve pair', 'serve-devices': 'serve devices', 'serve-agents': 'serve agents',
  backup: 'backup', connect: 'connect', bridge: 'bridge',
};
/** Options of a subcommand that a chat launch refuses, each with the name of the first subcommand taking it. */
const ONLY_FOR = new Map<Key, string>();
for (const command of COMMANDS) {
  for (const key of ALLOWED[command]) if (!ALLOWED.chat.has(key) && !ONLY_FOR.has(key)) ONLY_FOR.set(key, COMMAND_NAMES[command]);
}
/** Options that set up a local launch, so an attached chat (which uses the server's) refuses them. */
const LAUNCH_ONLY: readonly Key[] = ['allowTools', 'noTools', 'cwd', 'modelSpec', 'thinkingLevel', 'authFile', 'plain'];
/** Options of a local chat, which a remote one (--remote, `connect`) refuses: the remote server has its own. */
const REMOTE_REFUSES: readonly Key[] = ['database', 'dataDir', 'modelSpec', 'thinkingLevel', 'authFile', 'plain', 'resume', 'history', 'status', 'prompt', 'requestId'];

/** Where the launch's model came from, highest precedence first. */
export type ModelSource = 'flag' | 'env' | 'settings' | 'default';
const MODEL_SOURCES: readonly ModelSource[] = ['flag', 'env', 'settings', 'default'];

/** Parsed command line. `model` is the --model flag's; resolveOptions() applies the other sources. */
export interface Options {
  command: Command;
  /** SSH destination, set by --remote or connect's positional argument. */
  remote?: string;
  remoteBin?: string;
  remoteDataDir?: string;
  /** Explicit local-host options a remote client must reject. */
  remoteUnsupported?: string;
  help?: boolean;
  version?: boolean;
  /** Coding tools for local chat and serve: on unless --no-tools; off for admin commands. */
  allowTools: boolean;
  /** Remote execution permission: only explicit --allow-tools enables this client process. */
  remoteAllowTools?: boolean;
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
  /** `serve agents --archive NAME`. */
  archive?: string;
  /** `serve agents --archive-adhoc`. */
  archiveAdhoc?: boolean;
  /** `serve agents --restore NAME`. */
  restore?: string;
  /** `backup --out DIR`. */
  out?: string;
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
  /** The standing agents: settings.json's `agents`, else the built-in roster (ADR 0027). */
  roster: Roster;
  /** PI_DURABLE_CHROMIUM: the browser kit's Chromium executable, an absolute path. */
  chromium?: string;
}

/** The subcommand that `words` (the positionals before any `--`) start with, and the words left after it. */
function command(words: readonly string[]): { command: Command; rest: readonly string[] } {
  const [first, second] = words;
  if (first === 'backup') return { command: 'backup', rest: words.slice(1) };
  if (first === 'connect') return { command: 'connect', rest: words.slice(1) };
  if (first === 'bridge') return { command: 'bridge', rest: words.slice(1) };
  if (first !== 'serve') return { command: 'chat', rest: words };
  if (second === 'pair') return { command: 'serve-pair', rest: words.slice(2) };
  if (second === 'devices') return { command: 'serve-devices', rest: words.slice(2) };
  if (second === 'agents') return { command: 'serve-agents', rest: words.slice(2) };
  return { command: 'serve', rest: words.slice(1) };
}


export function parseArgs(args: readonly string[]): Options {
  const options: Options = { command: 'chat', thinkingLevel: DEFAULT_THINKING, allowTools: true, remoteAllowTools: false };
  const words: string[] = [], literal: string[] = [];
  const given = new Map<Key, string>();
  const repeated: string[] = [];
  let thinking: string = options.thinkingLevel;
  for (let i = 0; i < args.length; i++) {
    // `--name=value` is `--name value`.
    const raw = args[i] ?? '', equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const arg = equals > 2 ? raw.slice(0, equals) : raw, inline = equals > 2 ? raw.slice(equals + 1) : undefined;
    const flag = FLAGS.get(arg), key = VALUES.get(arg);
    if (arg === '--') { literal.push(...args.slice(i + 1)); break; }
    if (flag && inline !== undefined) throw new Error(`${arg} takes no value`);
    if (flag) { options[flag] = true; given.set(flag, arg); }
    else if (key) {
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new Error(`${arg} requires a value`);
      if (given.has(key)) repeated.push(arg);
      given.set(key, arg);
      if (key === 'thinkingLevel') { thinking = value; options.thinkingFlag = true; }
      else options[key] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg} (pi-durable --help lists them)`);
    else words.push(arg);
  }
  if (options.help || options.version) return options;
  const { command: chosen, rest } = command(words);
  options.command = chosen;
  let prompts = [...rest, ...literal];
  if (chosen === 'connect') {
    if (repeated.length) throw new Error(`${repeated[0] ?? ''} must be given only once for connect`);
    if (rest.length !== 1 || literal.length) throw new Error('Usage: pi-durable connect SSH_HOST [--remote-bin PATH] [--remote-data-dir PATH]');
    options.remote = rest[0];
    prompts = [];
  }
  if (chosen !== 'chat') {
    const name = COMMAND_NAMES[chosen];
    if (prompts.length) {
      throw new Error(`Unknown ${name} argument: ${prompts[0] ?? ''}${chosen === 'serve' ? ' (to send a prompt starting with "serve", use -p)' : ''}`);
    }
    for (const [key, spelling] of given) if (!ALLOWED[chosen].has(key)) throw new Error(`${spelling} does not apply to ${name}`);
  } else {
    for (const [key, owner] of ONLY_FOR) {
      const spelling = given.get(key);
      if (spelling) throw new Error(`${spelling} applies only to ${owner}`);
    }
    if (options.local && options.attach) throw new Error('Choose either --local or --attach');
    if (options.local && options.remote !== undefined) throw new Error('Choose either --local or --remote');
    if (options.local && (options.remoteBin !== undefined || options.remoteDataDir !== undefined)) throw new Error('--remote-bin and --remote-data-dir do not apply to --local');
    options.remoteUnsupported = REMOTE_REFUSES.map(key => given.get(key)).find(spelling => spelling !== undefined);
    const local = LAUNCH_ONLY.map(key => given.get(key)).find(spelling => spelling !== undefined);
    if (local && options.attach) throw new Error(`${local} does not apply to --attach: the server's settings apply (use /model and /tools there)`);
    if (local) options.launchOption = local;
  }
  if (given.has('allowTools') && options.noTools) throw new Error('Choose either --allow-tools or --no-tools');
  // chat and serve start with coding tools on unless --no-tools (ADR 0025); backup and the admin commands never run them.
  options.allowTools = (chosen === 'chat' || chosen === 'serve') && !options.noTools;
  options.remoteAllowTools = chosen === 'chat' && given.has('allowTools') && !options.noTools;
  if (options.portSpec !== undefined) options.port = parsePort(options.portSpec, '--port');
  if (options.revoke !== undefined && !options.revoke.trim()) throw new Error('--revoke requires a device name');
  if (options.archive !== undefined && !options.archive.trim()) throw new Error('--archive requires an agent name');
  if (options.restore !== undefined && !options.restore.trim()) throw new Error('--restore requires an agent name');
  if ([options.archive !== undefined, options.archiveAdhoc, options.restore !== undefined].filter(Boolean).length > 1) {
    throw new Error('Choose only one of --archive, --archive-adhoc, or --restore');
  }
  if (prompts.length && options.prompt !== undefined) throw new Error('Use either --print or a positional prompt, not both');
  if (prompts.length) options.prompt = prompts.join(' ');
  if (options.prompt !== undefined && !options.prompt.trim()) throw new Error('Prompt cannot be empty');
  if (options.requestId !== undefined && (!options.requestId.trim() || options.prompt === undefined)) throw new Error('--request-id requires a nonempty ID and a one-shot prompt');
  const modes = [options.resume, options.history, options.status, options.prompt !== undefined].filter(Boolean);
  if (modes.length > 1) throw new Error('Choose only one of --resume, --history, --status, or a prompt');
  if (options.attach && modes.length) throw new Error('--attach is for interactive chat only');
  if (!isThinkingLevel(thinking)) throw new Error(`Invalid --thinking level "${thinking}": use one of ${THINKING.join(', ')}`);
  options.thinkingLevel = thinking;
  if (options.modelSpec !== undefined) options.model = parseModel(options.modelSpec, '--model');
  return options;
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

/** `path` with its symlinks resolved; rejects, naming `what`, when it is missing or not a directory. */
async function directory(path: string, what: string): Promise<string> {
  let real: string;
  try { real = await realpath(path); } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${what} ${path} does not exist`);
    throw error;
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`${what} ${path} is not a directory`);
  return real;
}

export async function resolveOptions(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const cwd = await directory(resolve(options.cwd ?? process.cwd()), options.cwd === undefined ? 'The working directory' : '--cwd');
  const dataDir = dataDirOf(options.dataDir, env);
  let databasePath = resolve(options.database ?? join(dataDir, 'chat.sqlite'));
  let exists = false;
  try { await access(databasePath); exists = true; } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const inspectOnly = Boolean(options.status || options.history);
  // Only work launches and serve create the chat; inspection and the admin commands never do.
  const creates = !inspectOnly && (options.command === 'chat' || options.command === 'serve');
  if (exists && (await stat(databasePath)).isDirectory()) throw new Error(`${databasePath} is a directory, not the chat's SQLite file`);
  if (exists) databasePath = await realpath(databasePath);
  else if (creates) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    databasePath = join(await realpath(dirname(databasePath)), basename(databasePath));
  }
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const paths = statePaths(databasePath, env);
  const serve = options.command === 'serve' ? { serve: serveSettings(options, env) } : {};
  // Only work launches run agents and read the roster, which an invalid entry makes a launch error; inspection and the
  // admin commands never read it.
  const runsAgents = (options.command === 'chat' || options.command === 'serve') && !inspectOnly;
  // Both read settings.json at once; a broken roster is still the error said first.
  const [rosterRead, modelRead] = await Promise.allSettled([
    runsAgents ? readRoster(paths.settings, { lenient: options.model !== undefined }) : DEFAULT_ROSTER, resolveModel(options, env, paths.settings)]);
  if (rosterRead.status === 'rejected') throw rosterRead.reason;
  if (modelRead.status === 'rejected') throw modelRead.reason;
  const roster = rosterRead.value, model = modelRead.value;
  const chromium = runsAgents ? chromiumPath(env) : undefined;
  return { ...options, ...model, roster, ...chromium ? { chromium } : {}, cwd, dataDir, databasePath,
    memoryDir: paths.memoryDir, settingsPath: paths.settings, ...paths.socket ? { socketPath: paths.socket } : {},
    serveDir: paths.serveDir, ...serve, exists, inspectOnly, authFile: resolve(options.authFile ?? join(agentDir, 'auth.json')) };
}

const STRINGS = ['cwd', 'dataDir', 'databasePath', 'memoryDir', 'settingsPath', 'serveDir', 'authFile'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_STRINGS = ['database', 'modelSpec', 'requestId', 'prompt', 'socketPath', 'portSpec', 'revoke', 'archive', 'restore', 'out', 'launchOption', 'chromium',
  'remote', 'remoteBin', 'remoteDataDir', 'remoteUnsupported'] as const satisfies readonly (keyof Config)[];
const BOOLEANS = ['allowTools', 'exists', 'inspectOnly'] as const satisfies readonly (keyof Config)[];
const OPTIONAL_BOOLEANS = ['help', 'version', 'noTools', 'resume', 'history', 'status', 'plain', 'local', 'attach', 'archiveAdhoc', 'thinkingFlag', 'remoteAllowTools'] as const satisfies readonly (keyof Config)[];
const isPort = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535;

function isServeSettings(x: unknown): x is ServeSettings {
  return isRecord(x) && isPort(x.port) && (x.origin === undefined || typeof x.origin === 'string')
    && Array.isArray(x.allowLogins) && x.allowLogins.every(login => typeof login === 'string')
    && (x.remoteTools === 'confirm' || x.remoteTools === 'off')
    && (x.toolsIdleMinutes === undefined || (typeof x.toolsIdleMinutes === 'number' && Number.isInteger(x.toolsIdleMinutes) && x.toolsIdleMinutes >= 1))
    && typeof x.pushPreview === 'boolean';
}
const isModelRef = (x: unknown): x is ModelRef => isRecord(x) && typeof x.provider === 'string' && typeof x.modelId === 'string';

/** A resolved roster, as `JSON.stringify(config)` carries it. */
function isRoster(x: unknown): x is Roster {
  return isRecord(x) && Object.entries(x).every(([name, agent]) => isAgentName(name) && isRecord(agent)
    && isModelRef(agent.model) && isThinkingLevel(agent.thinkingLevel) && Array.isArray(agent.tools) && agent.tools.every(isKit)
    && (agent.instructions === undefined || typeof agent.instructions === 'string')
    && (agent.subModel === undefined || isModelRef(agent.subModel))
    && (agent.subThinkingLevel === undefined || isThinkingLevel(agent.subThinkingLevel)));
}

function isConfig(x: unknown): x is Config {
  if (!isRecord(x) || !isRecord(x.model)) return false;
  return typeof x.model.provider === 'string' && typeof x.model.modelId === 'string' && isThinkingLevel(x.thinkingLevel)
    && isRoster(x.roster)
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
