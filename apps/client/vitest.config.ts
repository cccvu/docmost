import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve the workspace editor-ext to its SOURCE (what the production Vite build uses via the package's
      // `module` field), not its gitignored, possibly-stale `dist/` — otherwise tests silently run old code
      // (#345: this masked the trailing-node/indent change-origin guards).
      '@docmost/editor-ext': path.resolve(
        __dirname,
        '../../packages/editor-ext/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
});
