// The client's rejoin loop (used after a reload or a dropped connection) against the real server.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ServerMsg } from '../src/shared/protocol';
import { rejoin, type RejoinOptions, type Welcome } from '../src/client/rejoin';
import type { Transport } from '../src/client/transport';
import { startServer, type RunningServer } from '../src/server/server';

let server: RunningServer;

before(async () => {
  server = await startServer({ port: 0, timings: { reconnectGraceMs: 2000 } });
});

after(async () => {
  await server.close();
});

/** A Node WebSocket wrapped like the browser transport, recording what it receives. */
async function connect(): Promise<Transport & { messages: ServerMsg[] }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const t = {
    local: false,
    messages: [] as ServerMsg[],
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    onMessage: (_msg: ServerMsg) => {},
    onClose: (_reason: string) => {},
  };
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    t.messages.push(msg);
    t.onMessage(msg);
  });
  ws.on('close', () => t.onClose('closed'));
  return t;
}

async function until<T>(get: () => T | undefined, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A room with two players; the first one's connection is then dropped. */
async function roomWithDroppedPlayer() {
  const ann = await connect();
  ann.send({ t: 'create', name: 'Ann' });
  const welcome = await until(() => ann.messages.find((m): m is Welcome => m.t === 'welcome'));
  const bob = await connect();
  bob.send({ t: 'join', code: welcome.code, name: 'Bob' });
  await until(() => bob.messages.find((m) => m.t === 'welcome'));
  ann.close();
  await until(() => bob.messages.find((m) => m.t === 'room' && m.players.some((p) => p.away)));
  return { welcome, bob, token: welcome.token! };
}

function options(over: Partial<RejoinOptions> & Pick<RejoinOptions, 'code' | 'token'>): RejoinOptions {
  return { open: connect, adopt: () => {}, wanted: () => true, giveUpMs: 1000, retryMs: 20, ...over };
}

test('a dropped player is handed their place back on a new connection', async () => {
  const { welcome, bob, token } = await roomWithDroppedPlayer();
  let adopted: Welcome | null = null;
  const result = await rejoin(options({ code: welcome.code, token, adopt: (t, w) => ((adopted = w), t.close()) }));
  assert.equal(result, 'ok');
  assert.equal(adopted!.id, welcome.id);
  bob.close();
});

test('it keeps trying while the server is out of reach', async () => {
  const { welcome, bob, token } = await roomWithDroppedPlayer();
  let attempts = 0;
  const open = () => (++attempts <= 2 ? Promise.reject(new Error('offline')) : connect());
  const result = await rejoin(options({ code: welcome.code, token, open, adopt: (t) => t.close() }));
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  bob.close();
});

test('it gives up when the place is gone or the server stays out of reach', async () => {
  const { welcome, bob } = await roomWithDroppedPlayer();
  assert.equal(await rejoin(options({ code: welcome.code, token: 'not-a-token' })), 'gone');
  const offline = () => Promise.reject(new Error('offline'));
  assert.equal(await rejoin(options({ code: welcome.code, token: 'x', open: offline, giveUpMs: 100 })), 'unreachable');
  bob.close();
});

test('a player who leaves while reconnecting gives the place up', async () => {
  const { welcome, bob, token } = await roomWithDroppedPlayer();
  let wanted = true;
  const open = async () => {
    const t = await connect();
    wanted = false; // The player pressed leave while this connection was opening.
    return t;
  };
  const result = await rejoin(options({ code: welcome.code, token, open, wanted: () => wanted }));
  assert.equal(result, 'cancelled');
  // Freed at once, well before the 2 s grace period would have let it expire.
  await until(() => bob.messages.find((m) => m.t === 'room' && m.players.length === 1), 1000);
  bob.close();
});
