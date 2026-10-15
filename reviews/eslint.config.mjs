import apify from '@apify/eslint-config/ts.js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tsEslint from 'typescript-eslint';

// eslint-disable-next-line import-x/no-default-export
export default [
    { ignores: ['**/dist', '**/test', 'eslint.config.mjs', 'vitest.config.ts'] },
    ...apify,
    prettier,
    {
        languageOptions: {
            parser: tsEslint.parser,
            parserOptions: {
                project: 'tsconfig.json',
            },
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            '@typescript-eslint': tsEslint.plugin,
        },
    },
];
