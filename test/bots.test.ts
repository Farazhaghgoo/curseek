import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SPEED, MAX_STEP, PLAYER_RADIUS, TICK_MS, WALL_HALF } from '../src/shared/constants';
import { distSqPointSegment, type Vec } from '../src/shared/geometry';
import { Maze } from '../src/shared/maze';
import { mulberry32 } from '../src/shared/rng';
import { moveCircle } from '../src/shared/physics';
import { BotBrain } from '../src/sim/bot';
import { Harness } from './helpers';

function soloRound(seed: number) {
  const h = new Harness({ seed, solo: true });
  const me = h.join('Idle');
  for (let i = 0; i < 4; i++) h.room.addBot();
  h.room.handle(me.id, { t: 'start' });
  return { h, me, ids: ['p1', 'b2', 'b3', 'b4', 'b5'] };
}

test('solo play starts with bots and a bot as the first seeker', () => {
  const { h, me } = soloRound(3);
  assert.equal(h.room.currentPhase, 'reveal');
  assert.ok(h.room.currentSeeker.startsWith('b'));
  assert.equal(me.inbox.last('room')!.players.filter((p) => p.bot).length, 4);
});

test('bots respect walls and the speed limit', () => {
  const { h, ids } = soloRound(7);
  const prev = new Map(ids.map((id) => [id, h.room.positionOf(id)!]));
  const travelled = new Map(ids.map((id) => [id, 0]));
  const minClear = PLAYER_RADIUS + WALL_HALF - 1e-6;
  const seconds = 30;
  for (let t = 0; t < seconds * 1000; t += TICK_MS) {
    h.advance(TICK_MS, TICK_MS);
    const maze = h.room.currentMaze!;
    for (const id of ids) {
      const p = h.room.positionOf(id);
      if (!p) continue;
      const q = prev.get(id)!;
      travelled.set(id, travelled.get(id)! + Math.hypot(p.x - q.x, p.y - q.y));
      prev.set(id, p);
      for (const e of maze.edges) {
        assert.ok(distSqPointSegment(p.x, p.y, e) >= minClear * minClear, `${id} inside a wall`);
      }
    }
  }
  for (const id of ids.slice(1)) {
    const d = travelled.get(id)!;
    assert.ok(d > 50, `${id} barely moved (${d.toFixed(0)})`);
    assert.ok(d <= MAX_SPEED * seconds * 1.01, `${id} too fast: ${d.toFixed(0)} in ${seconds}s`);
  }
});

test('a bot seeker finds and catches hiders', () => {
  let roundsWithCatches = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { h, me } = soloRound(seed);
    h.advance(96_000, 20);
    if (me.inbox.all('caught').length > 0) roundsWithCatches++;
  }
  assert.ok(roundsWithCatches >= 6, `only ${roundsWithCatches}/8 rounds had a capture`);
});

test('a bot hider runs away from a seeker it can see', () => {
  const maze = Maze.generate(mulberry32(11));
  // A hider two cells from a seeker along the maze.
  const start = 100;
  const seekerCell = maze.distancesFrom(start).findIndex((d) => d === 2);
  const seekerPos = maze.cellCenter(seekerCell);

  const brain = new BotBrain(mulberry32(5));
  const pos: Vec = maze.cellCenter(start);
  for (let i = 0; i < 90; i++) {
    const want = brain.step({ maze, now: i * TICK_MS, role: 'hider', pos: { ...pos }, canMove: true, seen: [seekerPos], hint: null, items: [], maxStep: MAX_STEP });
    moveCircle(maze, pos, want.x, want.y);
  }
  const cellsAway = maze.distancesFrom(seekerCell)[maze.cellAt(pos.x, pos.y)];
  assert.ok(cellsAway >= 4, `only ${cellsAway} cells away after 1.5 s`);
});
