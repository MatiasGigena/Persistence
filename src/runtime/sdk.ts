/**
 * The Pi SDK release every `@earendil-works/*` package is pinned at (package.json; ADR 0037). A leaf with no imports,
 * so the CLI names it in `--help` and `--version` without loading the SDK; test/host/sdk.test.ts holds it to the
 * installed packages.
 */
export const SDK = '1.5.2';
