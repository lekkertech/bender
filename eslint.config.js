import tseslint from 'typescript-eslint';

const CEILINGS = {
  complexity: ['error', 10],
  'max-depth': ['error', 2],
  'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['error', { max: 25, skipBlankLines: true, skipComments: true }],
  'max-params': ['error', 4],
  'max-nested-callbacks': ['error', 3],
};

const asWarnings = Object.fromEntries(
  Object.entries(CEILINGS).map(([rule, cfg]) => [rule, ['warn', ...(cfg.slice(1))]]),
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: { ...asWarnings, '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    files: ['src/env.ts', 'src/features/boom/**/*.ts'],
    rules: CEILINGS,
  },
  {
    // Frozen verbatim copy of the pre-flag orchestration; see docs/adr/0001.
    files: ['src/features/boom/legacy/index.ts'],
    rules: { ...asWarnings, '@typescript-eslint/no-unused-vars': 'warn' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
);
