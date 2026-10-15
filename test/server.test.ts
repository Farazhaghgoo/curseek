import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';
import { startServer, type RunningServer } from '../src/server/server';
import type { Msg } from './helpers';

const TIMINGS = { revealMs: 300, fadeMs: 200, huntMs: 1500, hintEveryMs: 500, intermissionMs: 400, reconnectGraceMs: 400 };
let server: RunningServer;

before(async () => {
  server = await startServer({ port: 0, timings: TIMINGS });
});

after(async () => {
  await server.close();
});

class Client {
  readonly messages: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<void>;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => ws.on('close', () => resolve()));
  }

  static async connect(opts: { port?: number; origin?: string } = {}): Promise<Client> {
    const ws = new WebSocket(`ws://localhost:${opts.port ?? server.port}/ws`, { origin: opts.origin });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Client(ws);
  }

  send(msg: ClientMsg | Record<string, unknown> | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  all<T extends ServerMsg['t']>(t: T): Msg<T>[] {
    return this.messages.filter((m): m is Msg<T> => m.t === t);
  }

  async next<T extends ServerMsg['t']>(t: T, where: (m: Msg<T>) => boolean = () => true, timeout = 5000): Promise<Msg<T>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.messages.find((m): m is Msg<T> => m.t === t && where(m as Msg<T>));
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Forgets received messages, so later waits only match what arrives after this point. */
  clear(): void {
    this.messages.length = 0;
  }

  close(): Promise<void> {
    this.ws.close();
    return this.closed;
  }
}

async function makeRoom(names: string[]) {
  const host = await Client.connect();
  host.send({ t: 'create', name: names[0] });
  const welcome = await host.next('welcome');
  const clients = [host];
  for (const name of names.slice(1)) {
    const c = await Client.connect();
    c.send({ t: 'join', code: welcome.code.toLowerCase(), name });
    await c.next('welcome');
    clients.push(c);
  }
  await host.next('room', (m) => m.players.length === names.length);
  return { code: welcome.code, clients };
}

test('serves the game page', async () => {
  const res = await fetch(`http://localhost:${server.port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /curseek/);
});

test('two players join by code and complete a round with matching results', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob']);
  assert.match(code, /^[A-Z2-9]{4}$/);
  const [a, b] = clients;
  a.send({ t: 'start' });
  const [ra, rb] = await Promise.all([a.next('round'), b.next('round')]);
  assert.equal(ra.seekerId, rb.seekerId);
  assert.deepEqual(ra.maze, rb.maze);
  assert.notDeepEqual(ra.you, rb.you);

  const [ea, eb] = await Promise.all([a.next('end'), b.next('end')]);
  assert.deepEqual(ea, eb, 'both clients see the same result');
  assert.ok(ea.winner === 'hiders' || ea.winner === 'seeker');

  // Snapshots agree on the timer and remaining hiders.
  const sa = a.all('snap').filter((s) => s.ph === 'hunt').at(-1)!;
  const sb = b.all('snap').find((s) => s.st === sa.st);
  if (sb) {
    assert.equal(sa.pe, sb.pe);
    assert.equal(sa.alive, sb.alive);
  }
  // The next round starts on its own with the other player seeking.
  const [na] = await Promise.all([a.next('round', (m) => m.n === 2), b.next('round', (m) => m.n === 2)]);
  assert.notEqual(na.seekerId, ra.seekerId);
  await Promise.all(clients.map((c) => c.close()));
});

test('the server moves players only through validated input', async () => {
  const { clients } = await makeRoom(['Ann', 'Bob']);
  const [a, b] = clients;
  a.send({ t: 'start' });
  const round = await a.next('round');
  const hider = round.seekerId === (await a.next('welcome')).id ? b : a;
  const hiderRound = await hider.next('round');
  // Try to teleport and to send garbage: the position must stay put.
  hider.send({ t: 'input', r: hiderRound.n, s: 1, x: 5000, y: 5000 });
  hider.send({ t: 'input', r: hiderRound.n, s: 2, x: 'far', y: 0 });
  hider.send('not json');
  hider.send({ t: 'teleport', x: 1, y: 1 });
  const snap = await hider.next('snap', (s) => (s.you?.s ?? 0) >= 1);
  const moved = Math.hypot(snap.you!.x - hiderRound.you!.x, snap.you!.y - hiderRound.you!.y);
  assert.ok(moved <= 3.2, `moved ${moved} from one input`);
  await Promise.all(clients.map((c) => c.close()));
});

test('joining a missing room or a full room is refused', async () => {
  const lost = await Client.connect();
  lost.send({ t: 'join', code: 'ZZZZ', name: 'Lost' });
  assert.equal((await lost.next('error')).code, 'not-found');
  await lost.close();

  const { code, clients } = await makeRoom(['A', 'B', 'C', 'D', 'E', 'F']);
  const extra = await Client.connect();
  extra.send({ t: 'join', code, name: 'G' });
  assert.equal((await extra.next('error')).code, 'full');
  await extra.close();
  await Promise.all(clients.map((c) => c.close()));
});

test('host departure hands over the room; seeker departure ends the round', async () => {
  const { clients } = await makeRoom(['Ann', 'Bob', 'Cat']);
  const [a, b, c] = clients;
  const ids = await Promise.all(clients.map(async (cl) => (await cl.next('welcome')).id));
  b.clear();
  await a.close();
  const room = await b.next('room', (m) => m.players.length === 2);
  assert.equal(room.hostId, ids[1]);

  b.send({ t: 'start' });
  const round = await b.next('round');
  await c.next('round');
  const seeker = round.seekerId === ids[1] ? b : c;
  const other = seeker === b ? c : b;
  other.clear();
  await seeker.close();
  const end = await other.next('end');
  assert.equal(end.reason, 'seeker-left');
  const back = await other.next('room', (m) => m.status === 'lobby', 3000);
  assert.equal(back.players.length, 1);
  await other.close();
});

test('a dropped player resumes their place with the same id, host role and position', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob']);
  const [a, b] = clients;
  const welcome = await a.next('welcome');
  assert.ok(welcome.token);
  a.send({ t: 'start' });
  const round = await a.next('round');
  await a.close();

  const back = await Client.connect();
  back.send({ t: 'resume', code: code.toLowerCase(), token: welcome.token });
  const again = await back.next('welcome');
  assert.equal(again.id, welcome.id);
  assert.equal(again.token, welcome.token);
  assert.equal((await back.next('room')).hostId, welcome.id);
  const resumed = await back.next('round');
  assert.equal(resumed.n, round.n);
  assert.deepEqual(resumed.maze, round.maze);
  assert.deepEqual(resumed.you, round.you, 'at their own spot, not a new spawn');
  await back.next('snap');
  assert.ok(
    b.all('room').every((m) => m.players.length === 2),
    'the other player never saw them leave',
  );
  await Promise.all([back, b].map((c) => c.close()));
});

test('a place that is not resumed in time is freed as before, and its token stops working', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob', 'Cat']);
  const ids = await Promise.all(clients.map(async (c) => (await c.next('welcome')).id));
  clients[0].send({ t: 'start' });
  const round = await clients[0].next('round');
  const seeker = clients[ids.indexOf(round.seekerId)];
  const other = clients.find((c) => c !== seeker)!;
  const { token } = await seeker.next('welcome');
  const droppedAt = Date.now();
  await seeker.close();

  const end = await other.next('end');
  assert.equal(end.reason, 'seeker-left');
  assert.ok(Date.now() - droppedAt >= TIMINGS.reconnectGraceMs - 10, 'the place was held first');
  const late = await Client.connect();
  late.send({ t: 'resume', code, token: token! });
  assert.equal((await late.next('error')).code, 'expired');
  await Promise.all([...clients.filter((c) => c !== seeker), late].map((c) => c.close()));
});

test('a resume token only works in its own room', async () => {
  const one = await makeRoom(['Ann']);
  const two = await makeRoom(['Bob']);
  const { token } = await one.clients[0].next('welcome');
  const thief = await Client.connect();
  thief.send({ t: 'resume', code: two.code, token: token! });
  assert.equal((await thief.next('error')).code, 'expired');
  assert.equal(one.clients[0].all('error').length, 0, 'the real player is untouched');
  await Promise.all([...one.clients, ...two.clients, thief].map((c) => c.close()));
});

test('resuming from a second connection takes over from the first', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob']);
  const [a, b] = clients;
  const { id, token } = await a.next('welcome');
  const tab = await Client.connect();
  tab.send({ t: 'resume', code, token: token! });
  assert.equal((await tab.next('welcome')).id, id);
  assert.equal((await a.next('error')).code, 'replaced');
  await a.closed;
  // The old connection closing must not leave the player marked as away.
  tab.send({ t: 'start' });
  await tab.next('round');
  await Promise.all([tab, b].map((c) => c.close()));
});

test('leaving on purpose frees the place at once', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob']);
  const [a, b] = clients;
  const { token } = await a.next('welcome');
  const bId = (await b.next('welcome')).id;
  a.send({ t: 'leave' });
  const room = await b.next('room', (m) => m.players.length === 1);
  assert.equal(room.hostId, bId);
  const again = await Client.connect();
  again.send({ t: 'resume', code, token: token! });
  assert.equal((await again.next('error')).code, 'expired');
  await Promise.all([a, b, again].map((c) => c.close()));
});

test('a kicked player is told why and disconnected', async () => {
  const { clients } = await makeRoom(['Ann', 'Bob']);
  const [a, b] = clients;
  const bId = (await b.next('welcome')).id;
  a.send({ t: 'kick', id: bId });
  assert.equal((await b.next('error')).code, 'kicked');
  await b.closed;
  await a.next('room', (m) => m.players.length === 1);
  await a.close();
});

async function roomsSettleTo(count: number): Promise<void> {
  for (let i = 0; i < 200 && server.roomCount() !== count; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(server.roomCount(), count);
}

test('rooms are removed when the last human leaves', async () => {
  await roomsSettleTo(0); // Earlier tests' rooms close once their players' places expire.
  const { clients } = await makeRoom(['Solo']);
  clients[0].send({ t: 'addBot' });
  await clients[0].next('room', (m) => m.players.length === 2);
  assert.equal(server.roomCount(), 1);
  await clients[0].close();
  await roomsSettleTo(0);
});

test('late joiners watch until the next round', async () => {
  const { code, clients } = await makeRoom(['Ann', 'Bob']);
  clients[0].send({ t: 'start' });
  const first = await clients[0].next('round');
  const late = await Client.connect();
  late.send({ t: 'join', code, name: 'Late' });
  const welcome = await late.next('welcome');
  const room = await late.next('room');
  assert.equal(room.status, 'playing');
  assert.equal(room.players.find((p) => p.id === welcome.id)!.waiting, true);
  const watching = await late.next('round');
  assert.equal(watching.n, 1);
  assert.equal(watching.you, null);
  assert.equal((await late.next('snap')).view, first.seekerId);
  const next = await late.next('round', (m) => m.n === 2, 6000);
  assert.equal(next.n, 2);
  assert.ok(next.you);
  await Promise.all([...clients, late].map((c) => c.close()));
});

test('message floods close the connection', async () => {
  const c = await Client.connect();
  for (let i = 0; i < 400; i++) c.send({ t: 'ping', c: i });
  await c.closed;
});

test('connections are limited by origin, address, room count and idleness', async () => {
  const limited = await startServer({ port: 0, limits: { connectionsPerAddress: 2, rooms: 1, idleMs: 300 } });
  const port = limited.port;
  try {
    await assert.rejects(Client.connect({ port, origin: 'https://elsewhere.example' }), /403/);
    const a = await Client.connect({ port, origin: `http://localhost:${port}` });
    const b = await Client.connect({ port });
    await assert.rejects(Client.connect({ port }), /429/, 'a third connection from one address');

    a.send({ t: 'create', name: 'Ann' });
    await a.next('welcome');
    b.send({ t: 'create', name: 'Bob' });
    assert.equal((await b.next('error')).code, 'busy', 'only one room fits');

    await b.closed; // Never joined a room, so it is closed as idle.
    assert.equal(a.ws.readyState, WebSocket.OPEN, 'players in a room stay connected');
    const c = await Client.connect({ port });
    await c.close();
    await a.close();
  } finally {
    await limited.close();
  }
});
