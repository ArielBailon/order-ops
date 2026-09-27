import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  resolve: {
    // Spec files are excluded from the app tsconfigs, so the plugin does not
    // apply their `paths` to them.
    alias: [
      {
        find: /^@app\/(auth|prisma)$/,
        replacement: fileURLToPath(new URL('./libs/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
