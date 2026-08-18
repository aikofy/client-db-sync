import { defineConfig } from 'tsup';

export default defineConfig([
  // Library (ESM + CJS for programmatic use)
  {
    entry: ['src/index.ts', 'src/embed.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    outDir: 'dist',
  },
  // CLI entrypoints (ESM only — use import.meta, top-level await)
  {
    entry: {
      cli: 'src/cli.ts',
      'scripts/generate-keys': 'scripts/generate-keys.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    clean: false,
    target: 'node18',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
