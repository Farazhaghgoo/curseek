import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Maze } from '../src/shared/maze';
import { mulberry32 } from '../src/shared/rng';
import { chooseSpawns } from '../src/shared/spawn';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

test('every cell is reachable from every other cell', () => {
  for (const seed of SEEDS) {
    const maze = Maze.generate(mulberry32(seed));
    const dist = maze.distancesFrom(0);
    assert.ok(
      dist.every((d) => d >= 0),
      `seed ${seed} has unreachable cells`,
    );
  }
});

test('mazes contain loops (more openings than a spanning tree)', () => {
  for (const seed of SEEDS) {
    const maze = Maze.generate(mulberry32(seed));
    let openings = 0;
    for (let i = 0; i < maze.cellCount; i++) openings += maze.neighbours(i).length;
    openings /= 2;
    const extra = openings - (maze.cellCount - 1);
    assert.ok(extra >= maze.cellCount * 0.05, `seed ${seed} has only ${extra} loops`);
  }
});

test('outer boundary is fully walled', () => {
  const maze = Maze.generate(mulberry32(5));
  for (let x = 0; x < maze.cols; x++) {
    assert.equal(maze.h[x], 1);
    assert.equal(maze.h[maze.rows * maze.cols + x], 1);
  }
  for (let y = 0; y < maze.rows; y++) {
    assert.equal(maze.v[y * (maze.cols + 1)], 1);
    assert.equal(maze.v[y * (maze.cols + 1) + maze.cols], 1);
  }
});

test('no interior grid vertex is left without a wall (no open rooms)', () => {
  for (const seed of SEEDS) {
    const maze = Maze.generate(mulberry32(seed));
    const { cols, rows, h, v } = maze;
    for (let vy = 1; vy < rows; vy++) {
      for (let vx = 1; vx < cols; vx++) {
        const n = h[vy * cols + vx - 1] + h[vy * cols + vx] + v[(vy - 1) * (cols + 1) + vx] + v[vy * (cols + 1) + vx];
        assert.ok(n > 0, `seed ${seed}: open vertex at ${vx},${vy}`);
      }
    }
  }
});

test('maze data round-trips through serialisation', () => {
  const maze = Maze.generate(mulberry32(42));
  const copy = Maze.fromData(JSON.parse(JSON.stringify(maze.toData())));
  assert.deepEqual(copy.edges, maze.edges);
  assert.deepEqual(copy.runs, maze.runs);
});

test('new seeds produce different mazes', () => {
  const a = Maze.generate(mulberry32(1)).toData();
  const b = Maze.generate(mulberry32(2)).toData();
  assert.notEqual(a.h + a.v, b.h + b.v);
});

test('path returns a walkable route between cells', () => {
  const maze = Maze.generate(mulberry32(9));
  const route = maze.path(0, maze.cellCount - 1);
  assert.equal(route[0], 0);
  assert.equal(route.at(-1), maze.cellCount - 1);
  for (let i = 1; i < route.length; i++) assert.ok(maze.neighbours(route[i - 1]).includes(route[i]));
  assert.equal(route.length - 1, maze.distancesFrom(0)[maze.cellCount - 1]);
});

test('spawns are distinct, reachable and separated from the seeker', () => {
  for (const seed of SEEDS) {
    const rng = mulberry32(seed);
    const maze = Maze.generate(rng);
    const plan = chooseSpawns(maze, rng, 5);
    const all = [plan.seeker, ...plan.hiders];
    assert.equal(new Set(all).size, all.length, `seed ${seed} reused a spawn`);
    const fromSeeker = maze.distancesFrom(plan.seeker);
    for (const h of plan.hiders) {
      assert.ok(fromSeeker[h] >= 6, `seed ${seed}: hider spawn only ${fromSeeker[h]} cells from seeker`);
    }
  }
});
