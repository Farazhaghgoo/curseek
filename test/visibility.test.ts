import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL, VIEW_RADIUS } from '../src/shared/constants';
import { segmentsIntersect } from '../src/shared/geometry';
import { Maze } from '../src/shared/maze';
import { mulberry32 } from '../src/shared/rng';
import { canSee, lineOfSight, pathClear, visibilityPolygon } from '../src/shared/visibility';

/** Two cells side by side with a wall between them, and a 2x1 open corridor below. */
function wallBetween(): Maze {
  const cols = 2;
  const rows = 2;
  const h = new Uint8Array((rows + 1) * cols).fill(1);
  const v = new Uint8Array(rows * (cols + 1)).fill(1);
  v[4] = 0; // bottom row open between (0,1) and (1,1)
  return new Maze(cols, rows, CELL, h, v);
}

test('walls block line of sight and seeing', () => {
  const maze = wallBetween();
  const a = { x: CELL * 0.5, y: CELL * 0.5 };
  const b = { x: CELL * 1.5, y: CELL * 0.5 };
  assert.equal(lineOfSight(maze, a.x, a.y, b.x, b.y), false);
  assert.equal(canSee(maze, a, b, 1000), false);
  const c = { x: CELL * 0.5, y: CELL * 1.5 };
  const d = { x: CELL * 1.5, y: CELL * 1.5 };
  assert.equal(canSee(maze, c, d, 1000), true);
  assert.equal(canSee(maze, c, d, CELL * 0.5), false, 'range applies');
});

test('rays cannot slip through the joint between two wall edges', () => {
  const maze = wallBetween();
  // Aim exactly at the shared vertex between the two top-row walls.
  assert.equal(lineOfSight(maze, CELL * 0.5, CELL * 0.5, CELL * 1.5, CELL * 1.5), false);
});

test('pathClear accounts for player radius', () => {
  const maze = wallBetween();
  assert.equal(pathClear(maze, CELL * 0.5, CELL * 1.5, CELL * 1.5, CELL * 1.5), true);
  assert.equal(pathClear(maze, CELL * 0.5, CELL * 1.05, CELL * 1.5, CELL * 1.05), false);
});

test('visibility polygon never extends through a wall', () => {
  const rng = mulberry32(77);
  const maze = Maze.generate(rng);
  for (let trial = 0; trial < 60; trial++) {
    const o = maze.cellCenter(Math.floor(rng() * maze.cellCount));
    o.x += (rng() - 0.5) * CELL * 0.4;
    o.y += (rng() - 0.5) * CELL * 0.4;
    const poly = visibilityPolygon(maze, o.x, o.y, VIEW_RADIUS);
    for (let i = 0; i < poly.length; i += 2) {
      const px = poly[i];
      const py = poly[i + 1];
      assert.ok(Math.hypot(px - o.x, py - o.y) <= VIEW_RADIUS + 1e-6);
      // Pull the point slightly toward the origin: that shortened ray must be unobstructed.
      const qx = o.x + (px - o.x) * 0.999;
      const qy = o.y + (py - o.y) * 0.999;
      const blocked = maze.runs.some((s) => segmentsIntersect(o.x, o.y, qx, qy, s));
      assert.ok(!blocked, `trial ${trial}: polygon vertex behind a wall`);
    }
  }
});
