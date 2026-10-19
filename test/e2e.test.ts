// End-to-end: two real client Sessions (the browser's networking, prediction and
// reconciliation code) talk to the real server over WebSockets and play a round.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { MAX_STEP, TICK_MS } from '../src/shared/constants';
import type { Vec } from '../src/shared/geometry';
import type { ServerMsg } from '../src/shared/protocol';
import { Session, type EndInfo, type SessionListener } from '../src/client/session';
import type { Transport } from '../src/client/transport';
import { startServer, type RunningServer } from '../src/server/server';

let server: RunningServer;

before(async () => {
  server = await startServer({
    port: 0,
    timings: { revealMs: 300, fadeMs: 200, huntMs: 25_000, hintEveryMs: 2000, intermissionMs: 500 },
  });
});

after(async () => {
  await server.close();
});

async function nodeTransport(): Promise<Transport> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const t: Transport = {
    local: false,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    onMessage: () => {},
    onClose: () => {},
  };
  ws.on('message', (data) => t.onMessage(JSON.parse(data.toString()) as ServerMsg));
  ws.on('close', () => t.onClose('closed'));
  return t;
}

interface Player {
  session: Session;
  events: string[];
  ends: EndInfo[];
  caught: Extract<ServerMsg, { t: 'caught' }>[];
  hints: number[];
}

async function connect(): Promise<Player> {
  const events: string[] = [];
  const ends: EndInfo[] = [];
  const caught: Player['caught'] = [];
  const hints: number[] = [];
  const listener: SessionListener = {
    welcome: () => events.push('welcome'),
    room: () => events.push('room'),
    round: () => events.push('round'),
    caught: (m) => caught.push(m),
    hint: (a) => hints.push(a),
    pickup: () => {},
    end: (e) => ends.push(e),
    error: (m) => events.push(`error:${m}`),
    closed: () => events.push('closed'),
  };
  const session = new Session(await nodeTransport(), listener);
  return { session, events, ends, caught, hints };
}

async function until(cond: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Walks from cell centre to cell centre along the maze path toward `target`. */
function chaseStep(session: Session, target: Vec): Vec {
  const maze = session.maze!;
  const path = maze.path(maze.cellAt(session.pos.x, session.pos.y), maze.cellAt(target.x, target.y));
  const c0 = maze.cellCenter(path[0]);
  let wp = c0;
  if (path.length === 1) {
    wp = target;
  } else {
    // Once lined up with the next cell (paths are axis-aligned), head straight for it.
    const c1 = maze.cellCenter(path[1]);
    const offAxis = c1.x !== c0.x ? Math.abs(session.pos.y - c0.y) : Math.abs(session.pos.x - c0.x);
    if (offAxis < 0.5) wp = c1;
  }
  const dx = wp.x - session.pos.x;
  const dy = wp.y - session.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const step = Math.min(d, MAX_STEP);
  return { x: (dx / d) * step, y: (dy / d) * step };
}

test('two networked clients play a round to a capture and agree on everything', async () => {
  const a = await connect();
  a.session.send({ t: 'create', name: 'Ann' });
  await until(() => a.session.code !== '');
  const b = await connect();
  b.session.send({ t: 'join', name: 'Bob', code: a.session.code });
  await until(() => a.session.players.length === 2 && b.session.players.length === 2);

  a.session.send({ t: 'start' });
  await until(() => a.session.maze !== null && b.session.maze !== null);
  const seeker = a.session.isSeeker ? a : b;
  const hider = seeker === a ? b : a;
  assert.equal(seeker.session.seekerId, hider.session.seekerId);
  const hiderSpawn = { ...hider.session.pos };

  // The seeker tries to move during the reveal: neither prediction nor server lets it.
  const spawn = { ...seeker.session.pos };
  for (let i = 0; i < 10; i++) seeker.session.tick({ x: MAX_STEP, y: 0 });
  assert.deepEqual(seeker.session.pos, spawn);

  // Play at 60 Hz: the seeker hunts the (stationary) hider once released.
  let maxCorrection = 0;
  let seen = false;
  const timer = setInterval(() => {
    const s = seeker.session;
    if (s.maze && s.canMoveNow()) s.tick(chaseStep(s, hiderSpawn));
    else s.tick({ x: 0, y: 0 });
    hider.session.tick({ x: 0, y: 0 });
    maxCorrection = Math.max(maxCorrection, Math.hypot(s.correction.x, s.correction.y));
    if (s.remotePositions().has(hider.session.myId)) seen = true;
  }, TICK_MS);
  try {
    await until(() => seeker.ends.length > 0 && hider.ends.length > 0, 30_000);
  } finally {
    clearInterval(timer);
  }

  assert.equal(seeker.ends[0].winner, 'seeker');
  assert.equal(seeker.ends[0].reason, 'all-caught');
  assert.deepEqual(seeker.ends[0], hider.ends[0], 'identical results on both clients');
  assert.deepEqual(
    seeker.caught.map((c) => c.id),
    [hider.session.myId],
  );
  assert.deepEqual(
    hider.caught.map((c) => c.id),
    [hider.session.myId],
  );
  assert.ok(hider.session.caught, 'the hider knows it was caught');
  assert.ok(seen, 'the seeker saw the hider before touching it');
  assert.ok(maxCorrection < 2, `prediction drifted from the server by ${maxCorrection.toFixed(2)}`);
  assert.equal(a.session.alive, b.session.alive);

  a.session.leave();
  b.session.leave();
});
