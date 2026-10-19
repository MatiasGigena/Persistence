// UniiChat memory for pi-durable: one chat that never ends; the chat itself is the memory.
//
//   const memory = openMemory(dir, { models, model });            // log + tree + view + background compactor
//   const extension = createUniiExtension({ memory, resolveAgentChat });
//   memory.append({ kind: 'work', text: '[Name] report…' });       // or memory.report({ name, text, id })
//   memory.render();                                              // the current view in <chat> tags
export { isKind, JOBS, KINDS, Memory, openMemory } from './memory.ts';
export type {
  AppendInput, Budget, CompactionPrompt, Kind, MemoryOptions, MemoryRecord, MemoryStatus, ReportInput, TreeNode,
} from './memory.ts';
export { createUniiExtension, REPORT_KIND } from './extension.ts';
export type { ContextEntries, RequestApi, UniiExtension, UniiExtensionOptions } from './extension.ts';
export { createPiAiSummarizer, defaultCompactionModel } from './summarizer.ts';
export type {
  CompactionMessage, CompactionNode, PiAiSummarizerOptions, Reasoning, SummarizeOptions, Summarizer, SummarizerModels,
} from './summarizer.ts';
export { PROMPT } from './prompt.ts';
export type { Pos } from './view.ts';
