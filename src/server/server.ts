import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStaticHandler, findPublicDir } from './static';

export interface ServerOptions {
  port?: number;
  host?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const http = createServer(createStaticHandler(findPublicDir()));
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
