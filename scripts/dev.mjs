// Development: rebuild the client bundle on change and restart the server on change.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { clientOptions } from './esbuild.config.mjs';

const ctx = await esbuild.context(clientOptions);
await ctx.watch();

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const server = spawn(process.execPath, [tsxCli, 'watch', 'src/server/main.ts'], { stdio: 'inherit' });

const stop = async () => {
  server.kill();
  await ctx.dispose();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  if (code !== null && code !== 0) process.exit(code);
});
