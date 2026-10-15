import { startServer } from './server';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || undefined;
const server = await startServer({ port, host, log: (msg) => console.log(msg) });
console.log(`curseek listening on http://localhost:${server.port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
