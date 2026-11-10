# 0040. The user searches the log; Pi does not

## Status

Accepted, 2026-11-10.

## Context

The chat never ends, and a client shows only its newest items. The memory keeps every message in its log, but the
only way back to an old one was the summary tree: open `/mem` (or the web app's Memory sheet) and zoom, line by
line, toward where the subject might be. That works when the summaries still name the subject. It fails for a detail
a summary dropped, and it is slow for "where did we talk about X".

The same question from the model's side is settled by the recipe this memory implements. Its prompt says: "Never
grep or search memories manually; zoom is your only allowed mechanism" (`src/memory/prompt.ts`). The view is built
so that the model reaches any message by zooming, and a search tool would give it a second path that skips the
summaries the view's budget pays for.

The log is already whole in the host's memory (`Memory.log`), as records of at most 30,000 characters.

## Decision

- **A search for the user only.** `Memory.search(query)` (`src/memory/search.ts`) is reached through
  `UiSession.search`: `/find words` in the terminal UI, and the "Search all messages" field of the web app's Memory
  sheet. It is not a tool, is not offered to Pi or to any agent, and nothing in the prompt mentions it. The
  `uniichat` extension's tools stay `zoom` and `date`.
- **Substring terms, all required.** A query is words apart by whitespace; every one must occur in a message's text,
  whatever the case, anywhere in a word. A part in double quotes is one phrase. `kind:user` (or `pi`, `tool`,
  `echo`, `work`, `note`) keeps one kind. A query without a word is refused readably.
- **No index, no embeddings.** Each search lower-cases every record once and looks for substrings. It runs in the
  host process, synchronously, and writes nothing. An inverted index would be a second persisted structure to keep
  in step with an append-only log, for a search a person runs now and then. Embeddings would need a model call per
  message and a vector store, would send the log to a provider again, and answer "what is like this", while the
  question here is "where is this word".
- **The answer is small.** The 50 newest matches, newest first, with the count of all of them. A hit is
  `{id, kind, date, snippet}`: the snippet is one line of about 160 characters around the first term. The message
  itself is opened with the existing `zoom(id, 1)`, so long messages keep their pages and no new reading path exists.
- **One additive protocol op**, `memory.search` (`{query}` to `{hits, total}`), for both peers. Its name is frozen
  with the other persisted and wire names. `PROTOCOL` stays 4; a server from before it answers `unknown_op`. A blank
  query, or one over 500 characters, is `bad_request`.

## Consequences

- The user finds a message by a word it holds, even when no summary mentions it. The search reads the log as
  written, so it never matches a summary's wording, and a text that was split at 30,000 characters is searched part
  by part: a phrase the split cut in two is not found.
- Pi's context, tools and prompt are unchanged, and so is everything on disk. The recipe's rule holds: the model
  still reaches its memory only by zooming. If Pi should find something for the user, the user can search and tell
  Pi the id, which `zoom` opens.
- The cost grows with the log: one pass over its text per search, during which the host does nothing else. On a
  synthetic log of 50,000 messages (28 million characters) a search took between 20 and 270 ms. Should that ever be
  felt, an index can be added behind `Memory.search` without changing the op.
- Matching is by code unit after lower-casing, without stemming, accent folding or word boundaries: `deploy` finds
  "redeployed" but `cafe` does not find "café".
- Only the 50 newest matches are listed. A common word needs more terms, a phrase or a `kind:` to reach older ones.
