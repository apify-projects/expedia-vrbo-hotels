import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: ['node_modules/**'],
        // The live smoke test (test/smoke.test.ts) hits the network; it is gated
        // inside the file by describe.skipIf(!SMOKE) — collected but skipped in the
        // standard run, executed via `npm run test:smoke` (SMOKE=1).
        testTimeout: 20_000,
    },
});
