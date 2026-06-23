import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/backend/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
);
