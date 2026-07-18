import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    // Agent worktrees nest a full second checkout under .claude/worktrees/ —
    // without this exclude their in-progress tests leak into every run.
    exclude: ['**/node_modules/**', '**/.next/**', '**/.claude/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
