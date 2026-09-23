import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Run from the repository root. Kept outside the backend's tests/**/*.ts compilation.
  root: '.',
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.tsx'],
    restoreMocks: true,
  },
});
