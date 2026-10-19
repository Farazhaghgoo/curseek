import { MAX_STEP, PLAYER_RADIUS, WALL_HALF } from './constants';
import { distSqPointSegment, type Vec } from './geometry';
import type { Maze } from './maze';

/**
 * Longest distance moved between collision resolutions. Walls are effectively
 * 2 * (PLAYER_RADIUS + WALL_HALF) thick for a player's centre, so substeps this small
 * can never carry the centre across a wall, however large the requested move.
 */
export const SUBSTEP = 1.5;

const closest: Vec = { x: 0, y: 0 };

/** Limits a requested per-tick displacement to the maximum speed, discarding any excess. */
export function clampStep(dx: number, dy: number, max = MAX_STEP): Vec {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  if (len <= max) return { x: dx, y: dy };
  const k = max / len;
  return { x: dx * k, y: dy * k };
}

/**
 * Pushes a circle out of any walls it overlaps. Walls are capsules (segments with rounded
 * ends), so the push direction follows the nearest surface and the circle slides along walls
 * and rounds wall ends instead of snagging on them. Returns true if it had to push: the circle
 * touched a wall.
 */
export function resolveWalls(maze: Maze, pos: Vec, radius = PLAYER_RADIUS): boolean {
  const min = radius + WALL_HALF;
  const minSq = min * min;
  let touched = false;
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    for (const idx of maze.wallsNear(pos.x, pos.y)) {
      const dSq = distSqPointSegment(pos.x, pos.y, maze.edges[idx], closest);
      if (dSq >= minSq) continue;
      const d = Math.sqrt(dSq);
      if (d < 1e-9) continue; // Unreachable with substepping; never guess a side.
      const k = (min - d) / d;
      pos.x += (pos.x - closest.x) * k;
      pos.y += (pos.y - closest.y) * k;
      pushed = true;
    }
    if (!pushed) break;
    touched = true;
  }
  // Final safety net: stay inside the outer boundary.
  const x = Math.min(maze.width - min, Math.max(min, pos.x));
  const y = Math.min(maze.height - min, Math.max(min, pos.y));
  if (x !== pos.x || y !== pos.y) touched = true;
  pos.x = x;
  pos.y = y;
  return touched;
}

/** True if a circle overlaps any wall. */
export function overlapsWall(maze: Maze, pos: Vec, radius = PLAYER_RADIUS): boolean {
  const min = radius + WALL_HALF - 1e-3;
  for (const idx of maze.wallsNear(pos.x, pos.y)) {
    if (distSqPointSegment(pos.x, pos.y, maze.edges[idx], closest) < min * min) return true;
  }
  return false;
}

/** Moves a circle straight through walls (the phase perk), keeping it inside the maze. */
export function moveFree(maze: Maze, pos: Vec, dx: number, dy: number, radius = PLAYER_RADIUS): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const min = radius + WALL_HALF;
  pos.x = Math.min(maze.width - min, Math.max(min, pos.x + dx));
  pos.y = Math.min(maze.height - min, Math.max(min, pos.y + dy));
}

/**
 * Ends a pass through walls: nobody may stay inside one. A circle left in a wall is pushed out to
 * the nearer side, or, if that fails (deep in a junction), put back at the centre of its cell.
 */
export function settle(maze: Maze, pos: Vec, radius = PLAYER_RADIUS): void {
  resolveWalls(maze, pos, radius);
  if (overlapsWall(maze, pos, radius)) maze.cellCenter(maze.cellAt(pos.x, pos.y), pos);
}

/**
 * Moves a circle by (dx, dy) in small substeps, resolving wall contacts after each one. Returns
 * true if it bumped into or scraped along a wall on the way.
 */
export function moveCircle(maze: Maze, pos: Vec, dx: number, dy: number, radius = PLAYER_RADIUS): boolean {
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return false;
  const steps = Math.ceil(len / SUBSTEP);
  const sx = dx / steps;
  const sy = dy / steps;
  let touched = false;
  for (let i = 0; i < steps; i++) {
    pos.x += sx;
    pos.y += sy;
    if (resolveWalls(maze, pos, radius)) touched = true;
  }
  return touched;
}
