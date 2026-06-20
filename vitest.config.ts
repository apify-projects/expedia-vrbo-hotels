import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // Live smoke test is opt-in (hits the network); excluded from the standard suite.
        exclude: ['test/smoke.test.ts', 'node_modules/**'],
        testTimeout: 20_000,
    },
});
