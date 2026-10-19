import tseslint from 'typescript-eslint';

// `any` is banned everywhere, written or inferred: use precise types or `unknown` and narrow.
export default tseslint.config(
  { ignores: ['node_modules/'] },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // The service worker has its own WebWorker project; src/web/tsconfig.json (DOM) excludes it.
  { files: ['src/web/sw.ts'], languageOptions: { parserOptions: { projectService: false, project: './src/web/sw/tsconfig.json', tsconfigRootDir: import.meta.dirname } } },
);
