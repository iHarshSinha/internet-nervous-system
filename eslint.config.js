import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'deploy/seed/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      // Type-only imports must say so; Node strips them when it runs .ts files directly.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },

  // Server and tools run on Node. All logging goes through pino, never console.
  {
    files: ['apps/server/**', 'tools/**', '*.config.js', 'apps/web/scripts/**'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'error' },
  },

  // The web app runs in the browser and in Web Workers.
  {
    files: ['apps/web/src/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  { files: ['apps/web/*.config.ts'], languageOptions: { globals: globals.node } },

  // Keep last: turns off rules that would fight with Prettier.
  prettier,
);
