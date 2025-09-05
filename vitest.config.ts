import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: [],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
  },
});