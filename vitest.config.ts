import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Minimal Vitest setup (Phase D): node environment, no DOM, no React
 * plugin - the suite covers server-side libs and route handlers with
 * mocked Supabase clients / injected fakes. Path alias mirrors tsconfig.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
