import globals from 'globals'
import react from 'eslint-plugin-react'

/**
 * Only the lints that are crashes, not style: an identifier nobody defined is a ReferenceError the
 * moment the code runs, and the bundler does not stop it. CI enforces this set (`yarn lint:runtime`);
 * the full style lint in eslint.config.js is advisory.
 */
export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '19.0' } },
    plugins: { react },
    rules: {
      'no-undef': 'error',
      'react/jsx-no-undef': 'error',
      'react/jsx-uses-vars': 'error',
    },
  },
]
