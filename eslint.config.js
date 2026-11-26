import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['mooncakes/**', 'node_modules/**', 'data/**', 'web.js', 'publish/**', 'artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
