import apify from '@apify/eslint-config/ts';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'storage/**',
            'spike/**',
            'src/**/*.py',
            // Auto-generated, byte-identical GraphQL query strings — must not be reformatted.
            'src/queries.ts',
        ],
    },
    ...apify,
    ...tseslint.configs.recommended,
    // Last, so Prettier owns formatting and ESLint stops reporting it.
    prettier,
    {
        // The TS config carries type-aware rules, which need a program. Point at
        // the check config so test files are covered too.
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { project: 'tsconfig.check.json' },
            globals: globals.node,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            // `__typename` etc. are real Expedia GraphQL field names.
            'no-underscore-dangle': 'off',
            // Only flag a destructure as const when ALL its bindings are const-able.
            'prefer-const': ['error', { destructuring: 'all' }],
        },
    },
    {
        // Tests: oracle strings exceed the line limit; rest-destructures intentionally drop keys.
        files: ['test/**'],
        rules: {
            'max-len': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
        },
    },
];
