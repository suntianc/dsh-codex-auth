import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    pool: 'forks',
    restoreMocks: true,
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
})
