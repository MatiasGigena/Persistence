import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// Syntax-check every .mjs under src/ and scripts/, plus the bash launcher.
const files = ['src', 'scripts'].flatMap(dir => readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.mjs')).map(f => `${dir}/${f}`));
const runs = [...files.sort().map(f => [process.execPath, ['--check', f]]), ['bash', ['-n', 'bin/pi-durable']]];
const failed = runs.filter(([cmd, args]) => spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0);
console.log(`check: ${runs.length - failed.length}/${runs.length} ok`);
process.exit(failed.length ? 1 : 0);
