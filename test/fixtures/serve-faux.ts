// `pi-durable serve` in a child process with a faux model: what src/host/host.ts runs for `serve`, minus the
// credential checks. argv[2] is the resolved Config as JSON; the answer streams a few characters at a time.
//
// The chunks are a fixed 12 characters, 120 ms apart, so a client sees the answer grow: pi-durable commits a partial
// at most every 100 ms and never commits the last chunk's, and a connection coalesces changes within 50 ms
// (LIMITS.flushMs). Random sizes (3 to 6 tokens) let a short tail chunk follow its predecessor within 100 ms, leaving
// no partial between the first and the final message, so the reply arrived as two puts and no append.
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { parseConfig } from '../../src/config/options.ts';
import { serve } from '../../src/server/serve.ts';

process.umask(0o077);
const config = parseConfig(process.argv[2]);
const faux = fauxProvider({ tokensPerSecond: 25, tokenSize: { min: 3, max: 3 } });
faux.setResponses([fauxAssistantMessage('There are three boats in the harbour, all of them blue.')]);
const models = createModels();
models.setProvider(faux.provider);
const shutdown = new AbortController();
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
  process.on(signal, () => { process.exitCode = code; shutdown.abort(); });
}
try {
  await serve(config, { models, signal: shutdown.signal });
} catch (error) {
  console.error(`serve-faux: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
