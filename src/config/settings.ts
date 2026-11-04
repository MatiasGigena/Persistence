// settings.json beside the database: the model and thinking level a launch without flags uses, and the standing agents'
// roster (ADR 0027), which only the user edits. Read by every launch; written only by a work launch's /model and
// /effort, under the database's flock.
import { readFile } from 'node:fs/promises';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { DEFAULT_ROSTER, isAgentName, isKit, KITS } from '../agents/roster.ts';
import type { Kit, Roster, StandingAgent } from '../agents/roster.ts';
import { errorCode, errorMessage, isRecord } from '../protocol/util.ts';
import { atomicWrite } from '../runtime/files.ts';
import { isThinkingLevel, THINKING } from '../runtime/thinking.ts';

export const DEFAULT_THINKING: ModelThinkingLevel = 'high';

/**
 * What settings.json holds: the defaults for launches without --model (or PI_DURABLE_MODEL) and --thinking, and the
 * standing agents' roster (`agents`), which only the user edits. `agents` is as written, unparsed: only `readRoster`
 * parses it, so the commands that run no agents never fail on it.
 */
export interface Settings {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  agents?: unknown;
}

/** `PROVIDER/ID` as a ModelRef; the ID may contain slashes. `what` names the source in the error. */
export function parseModel(spec: string, what: string): ModelRef {
  const slash = spec.indexOf('/');
  if (slash < 1 || slash === spec.length - 1) throw new Error(`${what} must be PROVIDER/MODEL_ID`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** settings.json's JSON object, or undefined when there is none. Rejects on a file that is not JSON or not an object. */
async function readSettingsJson(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${path} is not valid JSON (${errorMessage(error)}); fix or delete it`, { cause: error }); }
  if (!isRecord(value)) throw new Error(`${path} must be an object like {"model":"PROVIDER/MODEL_ID","thinkingLevel":"high"}; fix or delete it`);
  return value;
}

const ROSTER_FIELDS = new Set(['model', 'thinkingLevel', 'tools', 'instructions', 'subModel', 'subThinkingLevel']);

/**
 * settings.json's `agents` (ADR 0027) as a roster: keyed by agent name; `model` and `tools` required, `thinkingLevel`
 * defaults to high; `instructions`, `subModel` and `subThinkingLevel` optional. Rejects with the entry's name.
 */
export function parseRoster(value: unknown, path: string): Roster {
  if (!isRecord(value)) throw new Error(`"agents" in ${path} must be an object keyed by agent name; fix or delete it`);
  const roster: Record<string, StandingAgent> = {};
  const seen = new Set<string>();
  for (const [name, entry] of Object.entries(value)) {
    const fail = (problem: string): never => { throw new Error(`Standing agent "${name}" in ${path}: ${problem}`); };
    if (!isAgentName(name)) fail('the name must be a letter, then up to 31 letters, digits, _ or -, and not "Pi"');
    if (seen.has(name.toLowerCase())) fail('another standing agent has the same name (names ignore case)');
    seen.add(name.toLowerCase());
    const fields = isRecord(entry) ? entry : fail('must be an object like {"model":"PROVIDER/MODEL_ID","tools":["coding"]}');
    const unknown = Object.keys(fields).find(key => !ROSTER_FIELDS.has(key));
    if (unknown !== undefined) fail(`unknown field "${unknown}" (use ${[...ROSTER_FIELDS].join(', ')})`);
    const model = (key: 'model' | 'subModel'): ModelRef | undefined => {
      const spec = fields[key];
      if (spec === undefined) return key === 'model' ? fail('"model" is required') : undefined;
      if (typeof spec !== 'string') return fail(`"${key}" must be "PROVIDER/MODEL_ID"`);
      try { return parseModel(spec, `"${key}"`); } catch (error) { return fail(errorMessage(error)); }
    };
    const level = (key: 'thinkingLevel' | 'subThinkingLevel'): ModelThinkingLevel | undefined => {
      const given = fields[key];
      if (given === undefined || isThinkingLevel(given)) return given;
      return fail(`"${key}" must be one of ${THINKING.join(', ')}`);
    };
    const tools: unknown = fields.tools;
    const kits: Kit[] = Array.isArray(tools) && tools.every(isKit) ? [...new Set(tools)]
      : fail(`"tools" is required: a list of tool kits from ${KITS.join(', ')}`);
    if (fields.instructions !== undefined && typeof fields.instructions !== 'string') fail('"instructions" must be a string');
    const main = model('model'), subModel = model('subModel'), subThinkingLevel = level('subThinkingLevel');
    roster[name] = {
      model: main ?? fail('"model" is required'), thinkingLevel: level('thinkingLevel') ?? DEFAULT_THINKING, tools: kits,
      ...typeof fields.instructions === 'string' && fields.instructions.trim() ? { instructions: fields.instructions } : {},
      ...subModel ? { subModel } : {}, ...subThinkingLevel ? { subThinkingLevel } : {},
    };
  }
  return roster;
}

/**
 * settings.json, or {} when there is none. Rejects on a file that is not valid settings; `agents` passes through as
 * written (`readRoster` parses it).
 */
export async function readSettings(path: string): Promise<Settings> {
  return settingsOf(path, await readSettingsJson(path));
}

/** The settings in `value`, settings.json's object as read (undefined: no file); throws as `readSettings` rejects. */
function settingsOf(path: string, value: Record<string, unknown> | undefined): Settings {
  if (!value) return {};
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new Error(`${path} must be an object like {"model":"PROVIDER/MODEL_ID","thinkingLevel":"high"}; fix or delete it`);
  }
  if (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel)) {
    throw new Error(`"thinkingLevel" in ${path} must be one of ${THINKING.join(', ')}; fix or delete it`);
  }
  return { ...value.model === undefined ? {} : { model: parseModel(value.model, `"model" in ${path}`) },
    ...isThinkingLevel(value.thinkingLevel) ? { thinkingLevel: value.thinkingLevel } : {},
    ...value.agents === undefined ? {} : { agents: value.agents } };
}

/**
 * The launch's roster: settings.json's `agents`, else the built-in one. `lenient` (a launch with --model, which skips
 * a broken file) falls back to the built-in roster when the file is not a JSON object; an invalid `agents` always rejects.
 */
export async function readRoster(path: string, { lenient = false }: { lenient?: boolean } = {}): Promise<Roster> {
  let value: Record<string, unknown> | undefined;
  try { value = await readSettingsJson(path); } catch (error) {
    if (lenient) return DEFAULT_ROSTER;
    throw error;
  }
  return value?.agents === undefined ? DEFAULT_ROSTER : parseRoster(value.agents, path);
}

/**
 * Replace settings.json atomically (mode 600) with `model` and `thinkingLevel`, after the other keys of `kept` (the
 * file's JSON as read, so `agents` stays as the user wrote it). Only work launches write it, under the database's flock.
 */
export function writeSettings(path: string, { model, thinkingLevel }: Pick<Settings, 'model' | 'thinkingLevel'>,
  kept: Readonly<Record<string, unknown>> = {}): void {
  const json = { ...kept, ...model ? { model: `${model.provider}/${model.modelId}` } : {}, ...thinkingLevel ? { thinkingLevel } : {} };
  atomicWrite(path, `${JSON.stringify(json, null, 2)}\n`);
}

/** Change the model or thinking level in settings.json, keeping the rest, `agents` included, as it is. */
export async function updateSettings(path: string, change: Pick<Settings, 'model' | 'thinkingLevel'>): Promise<void> {
  const json = await readSettingsJson(path);
  const saved = settingsOf(path, json);
  writeSettings(path, { model: change.model ?? saved.model, thinkingLevel: change.thinkingLevel ?? saved.thinkingLevel }, json ?? {});
}
