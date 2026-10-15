// Shared esbuild settings for the browser bundle and the Node server bundle.

/** @type {import('esbuild').BuildOptions} */
export const clientOptions = {
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/build/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
export const serverOptions = {
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};
