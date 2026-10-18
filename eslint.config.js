// Minimal lint config: catches typos and dead code. Run with `npx eslint .`
export default [
  { ignores: ['vendor/**', 'test-results/**', 'tests/fixtures/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', self: 'readonly',
        console: 'readonly', performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly', localStorage: 'readonly', indexedDB: 'readonly', caches: 'readonly',
        fetch: 'readonly', URL: 'readonly', Blob: 'readonly', File: 'readonly', Worker: 'readonly',
        TextDecoder: 'readonly', DataView: 'readonly', ResizeObserver: 'readonly', Event: 'readonly',
        CustomEvent: 'readonly', EventTarget: 'readonly', Node: 'readonly', PointerEvent: 'readonly',
        AudioWorkletNode: 'readonly', AudioWorkletProcessor: 'readonly', OfflineAudioContext: 'readonly',
        registerProcessor: 'readonly', sampleRate: 'readonly', currentTime: 'readonly',
        confirm: 'readonly', prompt: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
        process: 'readonly', Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
    },
  },
];
