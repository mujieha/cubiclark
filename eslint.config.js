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
    { property: 'createContextualFragment', message: 'Parsing markup into nodes is never done here (S1-18).' },
    { property: 'parseFromString', message: 'DOMParser is never used here: build DOM nodes instead (S1-18).' },
    { property: 'setHTMLUnsafe', message: 'Use textContent or build DOM nodes; never set HTML (S1-18).' },
    { property: 'parseHTMLUnsafe', message: 'Use textContent or build DOM nodes; never parse HTML (S1-18).' },
    { property: 'srcdoc', message: 'An iframe with inline HTML is never used here (S1-18).' },
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
    // src/core is pure (design §3.7): no DOM, no clock, no animation frames. Flat config replaces a
    // rule's options per block, so the HTML-sink entries are repeated here rather than lost.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'localStorage', 'navigator', 'process'].map(
          (name) => ({ name, message: 'src/core is pure: pass the value in instead of reading it from the environment.' })
        ),
      ],
      'no-restricted-properties': [
        'error',
        ...htmlSinkBan['no-restricted-properties'].slice(1),
        { object: 'Date', property: 'now', message: 'src/core is pure: the clock is always passed in.' },
      ],
    },
  },
  {
    // The collector must never write to stdout or stderr (PLAN.md phase 2 §1.2): stdout on some
    // events becomes context for Claude, and any output is a token cost.
    files: ['src/hook/**/*.ts', 'src/core/hooks/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
)
