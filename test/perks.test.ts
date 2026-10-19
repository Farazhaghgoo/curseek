// Orbs, coins and the effects orbs give: the rules in the room, and the shared rules behind them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_STEP, VIEW_RADIUS } from '../src/shared/constants';
import { Maze } from '../src/shared/maze';
import {
  COIN_COUNT,
  COIN_RESPAWN_MS,
  EFFECTS,
  ORB_COUNT,
  lightRadius,
  rollEffect,
  speedFactor,
  type EffectKind,
} from '../src/shared/perks';
import { moveFree, overlapsWall, settle } from '../src/shared/physics';
import { mulberry32 } from '../src/shared/rng';
import { Harness, Inbox } from './helpers';

function startGame(names = ['Ann', 'Bob'], pickups = false) {
  const h = new Harness({ pickups });
  const players = names.map((n) => h.join(n));
  h.room.handle(players[0].id, { t: 'start' });
  const seekerId = h.room.currentSeeker;
  const seeker = players.find((p) => p.id === seekerId)!;
  const hiders = players.filter((p) => p.id !== seekerId);
  return { h, players, seeker, hiders };
}

let seq = 1;
function sendInput(h: Harness, id: string, inbox: Inbox, x: number, y: number): void {
  h.room.handle(id, { t: 'input', r: inbox.last('round')!.n, s: seq++, x, y });
}

/** A cell with a wall on its right-hand side, as world coordinates of that wall. */
function findRightWall(maze: Maze): { wallX: number; y: number } {
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols - 1; x++) {
      if (maze.v[y * (maze.cols + 1) + x + 1]) return { wallX: (x + 1) * maze.cell, y: (y + 0.5) * maze.cell };
    }
  }
  throw new Error('no interior wall');
}

/** Ids of the players in a player's latest snapshot: those seen, and those marked through walls. */
function lastSnap(h: Harness, p: { inbox: Inbox }) {
  p.inbox.clear();
  h.advance(40);
  const snap = p.inbox.last('snap')!;
  return { seen: snap.o.map((e) => e.i), marked: (snap.m ?? []).map((e) => e.i), fx: snap.fx };
}

test('orbs never give the seeker a cloak or a hider the radar; both sides can be cursed', () => {
  const rng = mulberry32(7);
  const got = { seeker: new Set<EffectKind>(), hider: new Set<EffectKind>() };
  for (let i = 0; i < 2000; i++) {
    got.seeker.add(rollEffect(rng, 'seeker'));
    got.hider.add(rollEffect(rng, 'hider'));
  }
  assert.deepEqual([...got.seeker].sort(), ['beacon', 'blind', 'flare', 'phase', 'radar', 'slow', 'speed']);
  assert.deepEqual([...got.hider].sort(), ['beacon', 'blind', 'cloak', 'flare', 'phase', 'slow', 'speed']);
});

test('speed and light effects multiply, and stop when they run out', () => {
  assert.equal(speedFactor({}, 0), 1);
  assert.equal(speedFactor({ speed: 100 }, 50), 1.6);
  assert.ok(Math.abs(speedFactor({ speed: 100, slow: 100 }, 50) - 1.6 * 0.55) < 1e-9);
  assert.equal(speedFactor({ speed: 100 }, 100), 1, 'over at its end time');
  assert.equal(lightRadius({ flare: 100 }, 0), VIEW_RADIUS * 2);
  assert.equal(lightRadius({ blind: 100 }, 0), VIEW_RADIUS * 0.45);
});

test('each round scatters orbs and coins, none near a player', () => {
  const { h, players } = startGame(['Ann', 'Bob', 'Cat'], true);
  const items = h.room.currentItems;
  assert.equal(items.filter((i) => i.k === 'orb').length, ORB_COUNT);
  assert.equal(items.filter((i) => i.k === 'coin').length, COIN_COUNT);
  for (const p of players) assert.deepEqual(p.inbox.last('round')!.items, items);
  const maze = h.room.currentMaze!;
  for (const p of players) {
    const pos = h.room.positionOf(p.id)!;
    const dist = maze.distancesFrom(maze.cellAt(pos.x, pos.y));
    for (const it of items) assert.ok(dist[maze.cellAt(it.x, it.y)] >= 3, 'at least three cells from every player');
  }
});

test('pickups can only be taken during the hunt, even by someone already on one', () => {
  const { h, hiders } = startGame();
  const hider = hiders[0];
  const p = h.room.positionOf(hider.id)!;
  h.room.placeItem('coin', p.x + 4, p.y);
  sendInput(h, hider.id, hider.inbox, 0.5, 0);
  h.advance(1000);
  assert.equal(h.room.currentItems.length, 1, 'still there during the reveal');
  h.toHunt();
  assert.equal(h.room.currentItems.length, 0, 'taken as the hunt starts, without moving');
});

test('a coin scores a point, then turns up somewhere else', () => {
  const { h, hiders, players } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const hider = hiders[0];
  const p = h.room.positionOf(hider.id)!;
  const id = h.room.placeItem('coin', p.x + 4, p.y);
  sendInput(h, hider.id, hider.inbox, 0.5, 0);
  for (const q of players) assert.deepEqual(q.inbox.last('pickup'), { t: 'pickup', id, by: hider.id });
  const score = (id: string) => players[0].inbox.last('room')!.players.find((q) => q.id === id)!.score;
  assert.equal(score(hider.id), 1);

  h.advance(COIN_RESPAWN_MS - 100);
  assert.equal(h.room.currentItems.length, 0);
  h.advance(200);
  const [coin] = h.room.currentItems;
  assert.equal(coin.k, 'coin');
  assert.notEqual(coin.id, id);
  for (const q of players) assert.deepEqual(q.inbox.last('item')!.item, coin);
});

test('an orb gives its finder an effect, and only they learn which', () => {
  const { h, hiders, players } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const hider = hiders[0];
  const p = h.room.positionOf(hider.id)!;
  h.room.placeItem('orb', p.x + 4, p.y);
  sendInput(h, hider.id, hider.inbox, 0.5, 0);
  const mine = hider.inbox.last('pickup')!;
  assert.ok(mine.fx && mine.fx !== 'radar', `a hider's effect: ${mine.fx}`);
  assert.equal(mine.u, h.now + EFFECTS[mine.fx].ms);
  assert.deepEqual(h.room.effectsOf(hider.id), { [mine.fx]: mine.u });
  for (const q of players) if (q !== hider) assert.equal(q.inbox.last('pickup')!.fx, undefined);
  assert.deepEqual(lastSnap(h, hider).fx, { [mine.fx]: mine.u }, 'snapshots carry it too');
});

test('a speed boost raises the top speed, and a slow lowers it', () => {
  const { h, hiders } = startGame();
  h.toHunt();
  const hider = hiders[0];
  const maze = h.room.currentMaze!;
  /** One input's length, from the middle of the hider's cell (well clear of its walls). */
  const oneStep = () => {
    const c = maze.cellCenter(maze.cellAt(h.room.positionOf(hider.id)!.x, h.room.positionOf(hider.id)!.y));
    h.room.placePlayer(hider.id, c.x, c.y);
    h.advance(300); // A full movement budget.
    sendInput(h, hider.id, hider.inbox, 100, 0);
    return h.room.positionOf(hider.id)!.x - c.x;
  };
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  near(oneStep(), MAX_STEP);
  h.room.giveEffect(hider.id, 'speed');
  near(oneStep(), MAX_STEP * 1.6);
  h.advance(EFFECTS.speed.ms);
  h.room.giveEffect(hider.id, 'slow');
  near(oneStep(), MAX_STEP * 0.55);
});

test('a cloaked hider is invisible to the seeker, but not to other hiders, and can still be caught', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const maze = h.room.currentMaze!;
  // A cell with two open sides: the cloaked hider in it, an onlooker on either side.
  let mid = 0;
  while (maze.neighbours(mid).length < 2) mid++;
  const [a, b] = maze.neighbours(mid).map((c) => maze.cellCenter(c));
  const m = maze.cellCenter(mid);
  h.room.placePlayer(hiders[0].id, m.x, m.y);
  h.room.placePlayer(seeker.id, a.x, a.y);
  h.room.placePlayer(hiders[1].id, b.x, b.y);
  assert.ok(lastSnap(h, seeker).seen.includes(hiders[0].id), 'in plain sight without the cloak');

  h.room.giveEffect(hiders[0].id, 'cloak');
  assert.ok(!lastSnap(h, seeker).seen.includes(hiders[0].id), 'the seeker cannot see them');
  assert.ok(lastSnap(h, hiders[1]).seen.includes(hiders[0].id), 'other hiders still can');

  h.room.placePlayer(hiders[0].id, a.x + 5, a.y);
  h.advance(20);
  assert.equal(seeker.inbox.last('caught')?.id, hiders[0].id);
});

test('the radar shows the seeker every uncloaked hider, through walls', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const maze = h.room.currentMaze!;
  const corner = maze.cellCenter(0);
  const far = maze.cellCenter(maze.cellCount - 1);
  const farther = maze.cellCenter(maze.cellCount - maze.cols);
  h.room.placePlayer(seeker.id, corner.x, corner.y);
  h.room.placePlayer(hiders[0].id, far.x, far.y);
  h.room.placePlayer(hiders[1].id, farther.x, farther.y);
  h.room.giveEffect(hiders[1].id, 'cloak');
  h.room.giveEffect(seeker.id, 'radar');
  const snap = lastSnap(h, seeker);
  assert.deepEqual(snap.marked, [hiders[0].id]);
  assert.deepEqual(snap.seen, []);
  assert.deepEqual(lastSnap(h, hiders[0]).marked, [], 'hiders get nothing');
  h.advance(EFFECTS.radar.ms);
  assert.deepEqual(lastSnap(h, seeker).marked, []);
});

test('a beacon shows whoever carries it to the other side', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  h.room.giveEffect(hiders[0].id, 'beacon');
  assert.deepEqual(lastSnap(h, seeker).marked, [hiders[0].id]);
  assert.deepEqual(lastSnap(h, hiders[1]).marked, [], 'not to the hider’s own side');

  h.advance(EFFECTS.beacon.ms);
  h.room.giveEffect(seeker.id, 'beacon');
  for (const hider of hiders) assert.deepEqual(lastSnap(h, hider).marked, [seeker.id]);
  assert.deepEqual(lastSnap(h, seeker).marked, []);
});

test('phase lets a player through walls, and nobody stays inside one when it ends', () => {
  const { h, hiders } = startGame();
  h.toHunt();
  const hider = hiders[0];
  const maze = h.room.currentMaze!;
  const wall = findRightWall(maze);
  h.room.placePlayer(hider.id, wall.wallX - 12, wall.y);
  h.room.giveEffect(hider.id, 'phase');
  h.advance(300);
  for (let i = 0; i < 8; i++) sendInput(h, hider.id, hider.inbox, MAX_STEP, 0);
  assert.ok(h.room.positionOf(hider.id)!.x > wall.wallX, 'through the wall');

  h.room.placePlayer(hider.id, wall.wallX + 1, wall.y);
  h.advance(EFFECTS.phase.ms);
  assert.ok(!overlapsWall(maze, h.room.positionOf(hider.id)!), 'pushed out of the wall');
});

test('settling puts a circle anywhere on any wall back in the open', () => {
  const maze = Maze.generate(mulberry32(3));
  for (const e of maze.edges) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const pos = { x: e.ax + (e.bx - e.ax) * t, y: e.ay + (e.by - e.ay) * t };
      settle(maze, pos);
      assert.ok(!overlapsWall(maze, pos), `stuck at (${pos.x}, ${pos.y})`);
    }
  }
  const pos = { x: 20, y: 20 };
  moveFree(maze, pos, -1000, 5000);
  assert.ok(pos.x > 0 && pos.y < maze.height, 'still inside the maze');
});
