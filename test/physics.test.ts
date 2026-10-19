import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL, MAX_STEP, PLAYER_RADIUS, WALL_HALF } from '../src/shared/constants';
import { distSqPointSegment, segmentsIntersect, type Vec } from '../src/shared/geometry';
import { Maze } from '../src/shared/maze';
import { clampStep, moveCircle, resolveWalls, SUBSTEP } from '../src/shared/physics';
import { mulberry32 } from '../src/shared/rng';

const CLEARANCE = PLAYER_RADIUS + WALL_HALF;

function minWallDistance(maze: Maze, p: Vec): number {
  let best = Infinity;
  for (const s of maze.edges) best = Math.min(best, Math.sqrt(distSqPointSegment(p.x, p.y, s)));
  return best;
}

function crossesWall(maze: Maze, a: Vec, b: Vec): boolean {
  return maze.edges.some((s) => segmentsIntersect(a.x, a.y, b.x, b.y, s));
}

/** Builds a maze from an ASCII-free description: all walls closed except the listed openings. */
function corridorMaze(): Maze {
  // 3x1 corridor: cells 0-1-2 joined horizontally, everything else walled.
  const cols = 3;
  const rows = 1;
  const h = new Uint8Array((rows + 1) * cols).fill(1);
  const v = new Uint8Array(rows * (cols + 1)).fill(1);
  v[1] = 0;
  v[2] = 0;
  return new Maze(cols, rows, CELL, h, v);
}

test('a huge single move cannot cross a wall', () => {
  const maze = corridorMaze();
  const pos = { x: CELL * 1.5, y: CELL * 0.5 };
  moveCircle(maze, pos, 0, 10_000);
  assert.ok(pos.y <= CELL - CLEARANCE + 1e-9, `escaped to y=${pos.y}`);
  moveCircle(maze, pos, 10_000, 0);
  assert.ok(pos.x <= CELL * 3 - CLEARANCE + 1e-9);
});

test('random fast moves never cross walls or end inside them', () => {
  const rng = mulberry32(1234);
  const maze = Maze.generate(rng);
  const pos = maze.cellCenter(0);
  for (let i = 0; i < 4000; i++) {
    const angle = rng() * Math.PI * 2;
    const len = rng() < 0.2 ? rng() * 400 : rng() * 8;
    const target = { x: Math.cos(angle) * len, y: Math.sin(angle) * len };
    // Replay the move substep by substep exactly as moveCircle does, checking each hop.
    const steps = Math.ceil(len / SUBSTEP);
    const check = { ...pos };
    for (let s = 0; s < steps; s++) {
      const before = { ...check };
      check.x += target.x / steps;
      check.y += target.y / steps;
      resolveWalls(maze, check);
      assert.ok(!crossesWall(maze, before, check), `crossed a wall at move ${i}`);
    }
    moveCircle(maze, pos, target.x, target.y);
    assert.ok(Math.abs(pos.x - check.x) < 1e-9 && Math.abs(pos.y - check.y) < 1e-9);
    assert.ok(minWallDistance(maze, pos) >= CLEARANCE - 1e-6, `penetrating a wall at move ${i}`);
  }
});

test('moving diagonally into a wall slides along it', () => {
  const maze = corridorMaze();
  const pos = { x: CELL * 0.5, y: CELL * 0.5 };
  // Push down-right: the floor stops vertical motion, horizontal motion continues.
  for (let i = 0; i < 20; i++) moveCircle(maze, pos, MAX_STEP * 0.7, MAX_STEP * 0.7);
  assert.ok(Math.abs(pos.y - (CELL - CLEARANCE)) < 1e-6, 'should rest against the floor');
  assert.ok(pos.x > CELL * 0.5 + 20 * MAX_STEP * 0.7 - 1e-6, 'should keep its full horizontal speed');
});

test('a move says whether it touched a wall', () => {
  const maze = corridorMaze();
  const pos = { x: CELL * 0.5, y: CELL * 0.5 };
  assert.equal(moveCircle(maze, pos, MAX_STEP, 0), false, 'along the middle of the corridor');
  assert.equal(moveCircle(maze, pos, 0, CELL), true, 'into the floor');
  assert.equal(moveCircle(maze, pos, MAX_STEP * 0.7, MAX_STEP * 0.7), true, 'scraping along it');
  assert.equal(moveCircle(maze, pos, 0, -MAX_STEP), false, 'away from it');
});

test('players round convex wall ends instead of sticking', () => {
  // A 2x2 U-shaped corridor around a wall stub hanging from the top boundary between
  // cells (0,0) and (1,0); the stub's free end is at (CELL, CELL).
  const cols = 2;
  const rows = 2;
  const h = new Uint8Array((rows + 1) * cols).fill(1);
  const v = new Uint8Array(rows * (cols + 1)).fill(1);
  v[4] = 0; // open between (0,1) and (1,1)
  h[2] = 0; // open between (0,0) and (0,1)
  h[3] = 0; // open between (1,0) and (1,1)
  const maze = new Maze(cols, rows, CELL, h, v);
  const pos = { x: CELL * 0.5, y: CELL * 0.5 };
  // Push right and slightly down: slide down the stub, round its end, carry on to the right.
  for (let i = 0; i < 60; i++) moveCircle(maze, pos, MAX_STEP, MAX_STEP * 0.5);
  assert.ok(pos.x > CELL * 1.4, `stuck at x=${pos.x}`);
});

test('clampStep enforces the maximum speed and rejects bad numbers', () => {
  const s = clampStep(300, 400);
  assert.ok(Math.abs(Math.hypot(s.x, s.y) - MAX_STEP) < 1e-9);
  assert.deepEqual(clampStep(1, 1), { x: 1, y: 1 });
  assert.deepEqual(clampStep(NaN, 1), { x: 0, y: 0 });
  assert.deepEqual(clampStep(Infinity, 1), { x: 0, y: 0 });
});
