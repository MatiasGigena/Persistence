// UniiChat memory for pi-durable: one chat that never ends; the chat itself is the memory.
//
//   const memory = openMemory(dir, { models, model });            // log + tree + view + background compactor
//   const extension = createUniiExtension({ memory, resolveAgentChat });
//   memory.append({ kind: 'work', text: '[Name] report…' });       // or memory.report({ name, text, id })
//   memory.render();                                              // the current view in <chat> tags
export { KINDS, Memory, openMemory } from './memory.ts';
export { createUniiExtension, REPORT_KIND } from './extension.ts';
export { createPiAiSummarizer, defaultCompactionModel } from './summarizer.ts';
export { PROMPT } from './prompt.ts';
