// ESLint flat config. The HTML-sink ban below is the one rule the TASK requires: it keeps
// untrusted transcript text (agent labels, tool targets, log lines) from ever reaching the DOM
// as markup instead of text.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const htmlSinkBan = {
  'no-restricted-properties': [
    'error',
    { property: 'innerHTML', message: 'Use textContent or build DOM nodes; never assign HTML.' },
    { property: 'outerHTML', message: 'Use textContent or build DOM nodes; never assign HTML.' },
    {
      property: 'insertAdjacentHTML',
      message: 'Use insertAdjacentText or build DOM nodes; never insert HTML.',
    },
    { object: 'document', property: 'write', message: 'document.write is never used here.' },
    { object: 'document', property: 'writeln', message: 'document.write is never used here.' },
  ],
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'tmp/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**',
      '.remember/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...htmlSinkBan,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['src/client/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
)
