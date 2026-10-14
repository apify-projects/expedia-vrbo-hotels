import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        env: { APIFY_LOG_LEVEL: 'ERROR' },
        setupFiles: ['./test/setup.ts'],
    },
});
