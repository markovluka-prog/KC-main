import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: [
      // Phase 1.5 S1: storage subpath must alias BEFORE the bare specifier so
      // Vite doesn't match the base alias first.
      {
        find: '@kc/game-rules/storage',
        replacement: fileURLToPath(new URL('../game-rules/src/save-storage.ts', import.meta.url)),
      },
      {
        find: '@kc/game-rules',
        replacement: fileURLToPath(new URL('../game-rules/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 5173,
    strictPort: false,
    // Dev proxy: forward REST + WebSocket to the local API (pnpm --filter @kc/api dev).
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // Security: source maps are NOT shipped to production — they leak
    // original TS, internal names, and architecture. Use `pnpm build:debug`
    // (set SOURCEMAP=1) locally if you need them for debugging.
    sourcemap: process.env.SOURCEMAP === '1' ? true : false,
    target: 'es2022',
  },
});
