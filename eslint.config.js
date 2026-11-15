// ESLint flat config for a GJS / GNOME Shell extension.
// Run `npm install` once, then `make lint`.
import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly',
    console: 'readonly',
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': ['error', {destructuring: 'all'}],
            'eqeqeq': ['error', 'smart'],
            'no-var': 'error',
            // GNOME Shell style: the class passed to registerClass() starts
            // at column 0, as in gnome-shell's own lint rules.
            'indent': ['error', 4, {
                SwitchCase: 0,
                ignoredNodes: [
                    'CallExpression[callee.object.name=GObject][callee.property.name=registerClass] > ClassExpression:first-child',
                ],
            }],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'object-curly-spacing': ['error', 'never'],
        },
    },
    {
        ignores: ['node_modules/', 'dist/', 'locale/'],
    },
];
