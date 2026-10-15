import { startServer } from './server';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || undefined;
const trustProxy = process.env.TRUST_PROXY === '1';
const server = await startServer({ port, host, trustProxy, log: (msg) => console.log(msg) });
console.log(`curseek listening on http://localhost:${server.port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
