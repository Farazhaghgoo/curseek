import * as esbuild from 'esbuild';
import { clientOptions, serverOptions } from './esbuild.config.mjs';

await Promise.all([
  esbuild.build({ ...clientOptions, minify: true }),
  esbuild.build(serverOptions),
]);
