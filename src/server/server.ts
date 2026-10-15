import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
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
  log?: (msg: string) => void;
}

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
  const http = createServer(createStaticHandler(findPublicDir()));
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
  const rooms = new Map<string, GameRoom>();

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  wss.on('connection', (ws) => {
    let room: GameRoom | null = null;
    let playerId: string | null = null;
    let alive = true;
    let windowStart = Date.now();
    let windowCount = 0;

    const send = (msg: ServerMsg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (msg.t === 'snap' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      ws.send(JSON.stringify(msg));
    };
    const sink: Sink = {
      send,
      // The player resumed on another connection, so this one no longer speaks for them.
      close: () => {
        room = null;
        playerId = null;
        ws.close(4000, 'Resumed elsewhere');
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
        } else {
          room.handle(playerId, msg);
        }
        return;
      }
      if (msg.t === 'create') {
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
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
