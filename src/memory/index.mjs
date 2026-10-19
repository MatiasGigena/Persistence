// UniiChat memory for pi-durable: one chat that never ends; the chat itself is the memory.
//
//   const memory = openMemory(dir, { models, model });            // log + tree + view + background compactor
//   const extension = createUniiExtension({ memory, resolveAgentChat });
//   memory.append({ kind: 'work', text: '[Name] report…' });       // or memory.report({ name, text, id })
//   memory.render();                                              // the current view in <chat> tags
export { KINDS, Memory, openMemory } from './memory.mjs';
export { createUniiExtension, REPORT_KIND } from './extension.mjs';
export { createPiAiSummarizer, defaultCompactionModel } from './summarizer.mjs';
export { PROMPT } from './prompt.mjs';
