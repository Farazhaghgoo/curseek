import { PLAYER_RADIUS, WALL_HALF } from './constants';
import { distSqPointSegment, distSqSegmentSegment, raySegment, segmentsIntersect, type Segment, type Vec } from './geometry';
import type { Maze } from './maze';

function boxMisses(s: Segment, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return (
    Math.max(s.ax, s.bx) < minX || Math.min(s.ax, s.bx) > maxX || Math.max(s.ay, s.by) < minY || Math.min(s.ay, s.by) > maxY
  );
}

/** True if the straight line from A to B crosses no wall. */
export function lineOfSight(maze: Maze, ax: number, ay: number, bx: number, by: number): boolean {
  const minX = Math.min(ax, bx);
  const minY = Math.min(ay, by);
  const maxX = Math.max(ax, bx);
  const maxY = Math.max(ay, by);
  for (const s of maze.runs) {
    if (boxMisses(s, minX, minY, maxX, maxY)) continue;
    if (segmentsIntersect(ax, ay, bx, by, s)) return false;
  }
  return true;
}

/** True if a circle of `radius` can travel in a straight line from A to B without touching a wall. */
export function pathClear(maze: Maze, ax: number, ay: number, bx: number, by: number, radius = PLAYER_RADIUS): boolean {
  const pad = radius + WALL_HALF;
  const padSq = pad * pad;
  const minX = Math.min(ax, bx) - pad;
  const minY = Math.min(ay, by) - pad;
  const maxX = Math.max(ax, bx) + pad;
  const maxY = Math.max(ay, by) + pad;
  for (const s of maze.runs) {
    if (boxMisses(s, minX, minY, maxX, maxY)) continue;
    if (distSqSegmentSegment(ax, ay, bx, by, s) < padSq) return false;
  }
  return true;
}

/**
 * Whether an observer at `from` can see a player at `to` within `range`. The target counts as
 * visible if its centre or either side of its body is in unobstructed line of sight, so a
 * player peeking past a corner is seen as soon as part of them is exposed.
 */
export function canSee(maze: Maze, from: Vec, to: Vec, range: number): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distSq = dx * dx + dy * dy;
  if (distSq > range * range) return false;
  if (lineOfSight(maze, from.x, from.y, to.x, to.y)) return true;
  const d = Math.sqrt(distSq);
  if (d < 1e-6) return true;
  const px = (-dy / d) * PLAYER_RADIUS * 0.9;
  const py = (dx / d) * PLAYER_RADIUS * 0.9;
  return (
    lineOfSight(maze, from.x, from.y, to.x + px, to.y + py) || lineOfSight(maze, from.x, from.y, to.x - px, to.y - py)
  );
}

/**
 * Polygon (flat [x0, y0, x1, y1, ...]) of everything visible from (ox, oy) within `radius`,
 * clipped by wall centre lines. Rays go both at regular angles (for the round edge) and just
 * either side of every nearby wall endpoint (for crisp shadow edges at corners).
 */
export function visibilityPolygon(maze: Maze, ox: number, oy: number, radius: number, baseRays = 256): number[] {
  const nearby: Segment[] = [];
  const rSq = radius * radius;
  for (const s of maze.runs) {
    if (distSqPointSegment(ox, oy, s) <= rSq) nearby.push(s);
  }

  const angles: number[] = [];
  for (let i = 0; i < baseRays; i++) angles.push((i / baseRays) * Math.PI * 2 - Math.PI);
  const eps = 1e-4;
  for (const s of nearby) {
    for (const [px, py] of [
      [s.ax, s.ay],
      [s.bx, s.by],
    ]) {
      const dx = px - ox;
      const dy = py - oy;
      if (dx * dx + dy * dy > rSq) continue;
      const a = Math.atan2(dy, dx);
      angles.push(a - eps, a, a + eps);
    }
  }
  angles.sort((a, b) => a - b);

  const out: number[] = [];
  for (const a of angles) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = radius;
    for (const s of nearby) {
      const hit = raySegment(ox, oy, dx, dy, s);
      if (hit < t) t = hit;
    }
    out.push(ox + dx * t, oy + dy * t);
  }
  return out;
}
