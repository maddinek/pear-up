// GJS is not node and not a browser, so the environment has to be described
// here: the shell injects `global`, gettext installs `_`, and modules are
// always ESM.
//
// Deliberately the recommended rule set and nothing stylistic. The value wanted
// from a linter here is the class of mistake that reads fine and breaks at
// runtime — an unused variable left behind by an edit, a name that does not
// exist, a promise nobody waits for. Formatting arguments can come later, and
// would bury that signal under hundreds of whitespace complaints.
import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', 'contrib/**', 'assets/**'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals['shared-node-browser'],
                // GJS runtime
                ARGV: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                console: 'readonly',
                // gnome-shell injects this into extensions
                global: 'readonly',
                // gettext, once the extension has initialised translations
                _: 'readonly',
                ngettext: 'readonly',
            },
        },
        rules: {
            // Caught things are often meant to be ignored here: a panel actor
            // may have been disposed by the shell, and there is nothing useful
            // to do about it. The comment in the block says so.
            'no-empty': ['error', { allowEmptyCatch: true }],
            // An unused argument is usually a signal handler's signature.
            'no-unused-vars': ['error', { args: 'none' }],
        },
    },
];
