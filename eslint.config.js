// Flat ESLint config for the workspace. Phase 1 P1 setup — lightweight rules:
// TS recommended + prettier-compat (formatting is delegated to Prettier).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
      'packages/web/public/**',
      'marketing/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLElement: 'readonly',
        fetch: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Defensive let-init followed by branch-assignment is fine; the rule
      // is noisy on this codebase.
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['packages/web/src/main.ts'],
    rules: {
      // main.ts is the legacy monolith staged for further extraction in
      // Phase 2 (cont.). Relax noise-rules here so lint stays useful.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
    },
  },
);
