import apify from '@apify/eslint-config';
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
    {
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
