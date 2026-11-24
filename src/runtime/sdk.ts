/**
 * The Pi SDK release every `@earendil-works/*` package is pinned at (package.json; ADRs 0037 and 0043). A leaf with no imports,
 * so the CLI names it in `--help` and `--version` without loading the SDK; test/host/sdk.test.ts holds it to the
 * installed packages.
 */
export const SDK = '1.6.0';
