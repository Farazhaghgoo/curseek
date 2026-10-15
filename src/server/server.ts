import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Timings } from '../shared/constants';
import { normaliseRoomCode, parseClientMsg, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { GameRoom, type Sink } from '../sim/room';
import { createStaticHandler, findPublicDir } from './static';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Overrides round timings (used by tests to play fast rounds). */
  timings?: Partial<Timings>;
  /** Behind a reverse proxy: take the client's address from X-Forwarded-For. */
  trustProxy?: boolean;
  limits?: Partial<Limits>;
  log?: (msg: string) => void;
}

/** Caps that keep one client, or a flood of them, from exhausting the server. */
export interface Limits {
  /** Open connections allowed from one address. */
  connectionsPerAddress: number;
  /** Open connections allowed in total. */
  connections: number;
  /** Rooms open at once. */
  rooms: number;
  /** Connections that are not in a room are closed after this long. */
  idleMs: number;
}

const DEFAULT_LIMITS: Limits = { connectionsPerAddress: 24, connections: 3000, rooms: 500, idleMs: 60_000 };

export interface RunningServer {
  port: number;
  /** Number of open rooms (for tests and diagnostics). */
  roomCount(): number;
  close(): Promise<void>;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
/** Generous for 60 Hz input plus pings; floods beyond this get the connection closed. */
const MAX_MESSAGES_PER_SECOND = 150;
const HEARTBEAT_MS = 10_000;
/** Skip snapshots for clients that are not keeping up instead of queueing them forever. */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** Resume tokens: 144 random bits, URL-safe. */
const newToken = () => randomBytes(18).toString('base64url');

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const rooms = new Map<string, GameRoom>();
  const serveStatic = createStaticHandler(findPublicDir());
  const http = createServer((req, res) => {
    // For load balancers and container health checks.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: wss.clients.size }));
      return;
    }
    void serveStatic(req, res);
  });
  const perAddress = new Map<string, number>();

  const addressOf = (req: IncomingMessage): string => {
    const forwarded = opts.trustProxy ? req.headers['x-forwarded-for'] : undefined;
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first || req.socket.remoteAddress || 'unknown';
  };

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: ({ origin, req }, done) => {
      // Browsers always send Origin: only this site's own pages may connect.
      if (origin && !sameHost(origin, req.headers.host)) return done(false, 403, 'Forbidden origin');
      if (wss.clients.size >= limits.connections) return done(false, 503, 'Server busy');
      if ((perAddress.get(addressOf(req)) ?? 0) >= limits.connectionsPerAddress) {
        return done(false, 429, 'Too many connections');
      }
      done(true);
    },
  });

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  wss.on('connection', (ws, req) => {
    let room: GameRoom | null = null;
    let playerId: string | null = null;
    let alive = true;
    let windowStart = Date.now();
    let windowCount = 0;

    const address = addressOf(req);
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    ws.on('close', () => {
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
    });

    // Connections only need to stay open while they are in a room.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!room) ws.close(1008, 'Idle');
      }, limits.idleMs);
    };
    armIdle();
    ws.on('close', () => clearTimeout(idleTimer));

    const send = (msg: ServerMsg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (msg.t === 'snap' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      ws.send(JSON.stringify(msg));
    };
    const sink: Sink = {
      send,
      // Resumed elsewhere or kicked: this connection no longer speaks for the player.
      close: () => {
        room = null;
        playerId = null;
        ws.close(4000, 'Removed from room');
      },
    };

    const joinRoom = (target: GameRoom, name: string) => {
      const id = target.addHuman(name, sink);
      if (!id) {
        send({ t: 'error', code: 'full', msg: 'That room is full (6 players max).' });
        return;
      }
      room = target;
      playerId = id;
    };

    const handle = (msg: ClientMsg) => {
      if (room && playerId) {
        if (msg.t === 'leave') {
          room.removePlayer(playerId);
          room = null;
          playerId = null;
          armIdle();
        } else {
          room.handle(playerId, msg);
        }
        return;
      }
      if (msg.t === 'create') {
        if (rooms.size >= limits.rooms) {
          send({ t: 'error', code: 'busy', msg: 'The server is full right now. Try again in a few minutes.' });
          return;
        }
        const code = newCode();
        const created = new GameRoom({ code, timings: opts.timings, newToken });
        rooms.set(code, created);
        joinRoom(created, msg.name);
        log(`room ${code} created`);
      } else if (msg.t === 'join') {
        const target = rooms.get(normaliseRoomCode(msg.code));
        if (!target) send({ t: 'error', code: 'not-found', msg: 'No room with that code. Check it and try again.' });
        else joinRoom(target, msg.name);
      } else if (msg.t === 'resume') {
        const target = rooms.get(normaliseRoomCode(msg.code));
        const id = target?.resume(msg.token, sink);
        if (!target || !id) {
          send({ t: 'error', code: 'expired', msg: 'Your place in that game has expired.' });
        } else {
          room = target;
          playerId = id;
        }
      } else if (msg.t === 'ping') {
        send({ t: 'pong', c: msg.c, s: performance.now() });
      }
    };

    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > MAX_MESSAGES_PER_SECOND) {
        ws.close(1008, 'Too many messages');
        return;
      }
      if (isBinary) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMsg(decoded);
      if (msg) handle(msg);
    });

    ws.on('close', () => {
      // Hold the player's place for a while: a reload or a brief outage can resume it.
      if (room && playerId) room.disconnect(playerId);
      room = null;
      playerId = null;
    });

    // Heartbeat: drop connections that stop answering pings (closed laptops, dead networks).
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('close', () => clearInterval(heartbeat));
  });

  const loop = setInterval(() => {
    for (const [code, room] of rooms) {
      room.update();
      // Closes once the last human has left, or has not come back in time.
      if (room.humanCount === 0) {
        rooms.delete(code);
        log(`room ${code} closed`);
      }
    }
  }, 5);

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    roomCount: () => rooms.size,
    close: async () => {
      clearInterval(loop);
      // Tell players why the game ended, so their clients do not try to rejoin rooms that are gone.
      const notice: ServerMsg = {
        t: 'error',
        code: 'shutdown',
        msg: 'The server restarted, so this game has ended. Start or join a new room.',
      };
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(notice));
        client.close(1012, 'Server restarting');
      }
      for (let i = 0; i < 25 && wss.clients.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
