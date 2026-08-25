import js from '@eslint/js';

// Zero-runtime-dependency SDK: management/core run server-side (Node),
// experience runs browser-side. Split globals per SDK_CONSTITUTION.md's own
// I-1 isolation split rather than unioning both into every file.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  globalThis: 'readonly',
  Buffer: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
  ReadableStream: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  // core/safety.js is isomorphic — feature-detects `document` via `typeof
  // document === 'undefined'` so it can build DOM nodes when loaded browser-side
  // while staying import-safe under plain Node. The typeof-guard makes it safe
  // even though this file's other globals are Node's.
  document: 'readonly',
};

const browserGlobals = {
  ...nodeGlobals,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  fetch: 'readonly',
  WebSocket: 'readonly',
  RTCPeerConnection: 'readonly',
  RTCSessionDescription: 'readonly',
  RTCIceCandidate: 'readonly',
  MediaStream: 'readonly',
  AudioContext: 'readonly',
  AudioWorkletProcessor: 'readonly',
  AudioWorkletGlobalScope: 'readonly',
  sampleRate: 'readonly',
  registerProcessor: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  HTMLElement: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
};

const testGlobals = {
  ...browserGlobals,
};

export default [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', '.harness-output/**', '.claude/worktrees/**'],
  },
  {
    files: ['src/management/**/*.js', 'src/core/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'tools/**/*.js', 'tools/**/*.mjs', 'examples/**/*.mjs', 'quickstart/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    files: ['src/experience/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: browserGlobals,
    },
  },
  {
    files: ['test/**/*.js', 'examples/**/*.js', 'quickstart/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: testGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    rules: {
      // varsIgnorePattern: '^_' covers the repo's existing "discard via
      // destructuring/for-of" convention (e.g. intellect-body.js's
      // `{ id: _id, ...keep }`, `for (const _ of iterable)`).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      // null: 'ignore' — `x == null` is the accepted idiom for "null or undefined"
      // across this codebase (safety.js, session.js, genui/**); every other
      // comparison still requires strict equality.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Sanitizer regexes intentionally match/strip ASCII control chars and a
    // literal hyphen inside a character class — both are the correct pattern
    // for an output-safety helper, not lint mistakes.
    files: ['src/core/safety.js'],
    rules: {
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
    },
  },
];
