# 0011. Strict TypeScript without a build step

## Status

Accepted, 2026-10-19. Extended by [0020](0020-web-client-without-build.md) to the web client.

## Context

The code was plain ESM in `.mjs` files. It sits on typed SDKs: pi-durable's `Harness`, `Conversation` and
`AgentChange`, Chord's `Context`, pi-ai's `Models`, and pi-coding-agent's `ModelRuntime`. Without types, mistakes
between modules surfaced only at runtime, or never: an empty object passed as the memory of an inspection, an argument
parser that took `constructor` for an option, stream-json and MCP messages used without being checked. The checker
that would have caught them already ships with the SDKs' declarations.

Node 22.18 and newer run `.ts` files directly by stripping the types, so typing no longer requires a compiler in the
run path.

## Decision

- Sources and tests are `.ts`, run by Node's type stripping. There is no build, bundler, or emitted JavaScript;
  `tsc` runs with `noEmit` and only checks.
- tsconfig is strict, with `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- `any` is banned, written or inferred: typescript-eslint's `no-explicit-any` and every `no-unsafe-*` rule are
  errors, and `ban-ts-comment` forbids `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck`. External data (JSON,
  IPC, process arguments) is parsed as `unknown` and narrowed.
- `npm run check` runs tsc, eslint with `--max-warnings 0`, and `bash -n` on the launcher, and must report zero.

## Consequences

- Erasable syntax only: no `enum`, `namespace`, parameter properties, or other syntax that needs emitting.
- Imports name `.ts` files (`allowImportingTsExtensions`), and type-only imports use `import type`.
- Node 22.18 or newer is required; `engines` and the launcher ask for 22.19.
- Stack traces and the debugger show the source as written, since nothing is compiled.
- typescript, typescript-eslint and eslint are dev dependencies; running the host needs none of them.
