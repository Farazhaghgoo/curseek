export interface Vec {
  x: number;
  y: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Squared distance from point P to segment S; writes the closest point into `out` when given. */
export function distSqPointSegment(px: number, py: number, s: Segment, out?: Vec): number {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const lenSq = vx * vx + vy * vy;
  let t = lenSq > 0 ? ((px - s.ax) * vx + (py - s.ay) * vy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = s.ax + vx * t;
  const cy = s.ay + vy * t;
  if (out) {
    out.x = cx;
    out.y = cy;
  }
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by)
  );
}

/** True when segment AB touches or crosses segment S (endpoints count as touching). */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, s: Segment): boolean {
  const d1 = orient(s.ax, s.ay, s.bx, s.by, ax, ay);
  const d2 = orient(s.ax, s.ay, s.bx, s.by, bx, by);
  const d3 = orient(ax, ay, bx, by, s.ax, s.ay);
  const d4 = orient(ax, ay, bx, by, s.bx, s.by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(s.ax, s.ay, s.bx, s.by, ax, ay)) return true;
  if (d2 === 0 && onSegment(s.ax, s.ay, s.bx, s.by, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, s.ax, s.ay)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, s.bx, s.by)) return true;
  return false;
}

/**
 * Distance along a ray (origin O, unit direction D) to segment S, or Infinity if the ray misses.
 * Segment endpoints are treated inclusively so rays cannot slip through wall joints.
 */
export function raySegment(ox: number, oy: number, dx: number, dy: number, s: Segment): number {
  const ex = s.bx - s.ax;
  const ey = s.by - s.ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const wx = s.ax - ox;
  const wy = s.ay - oy;
  const t = (wx * ey - wy * ex) / denom;
  const u = (wx * dy - wy * dx) / denom;
  if (t < 0 || u < -1e-9 || u > 1 + 1e-9) return Infinity;
  return t;
}

/** Squared minimum distance between segments AB and S. */
export function distSqSegmentSegment(ax: number, ay: number, bx: number, by: number, s: Segment): number {
  if (segmentsIntersect(ax, ay, bx, by, s)) return 0;
  const ab: Segment = { ax, ay, bx, by };
  return Math.min(
    distSqPointSegment(ax, ay, s),
    distSqPointSegment(bx, by, s),
    distSqPointSegment(s.ax, s.ay, ab),
    distSqPointSegment(s.bx, s.by, ab),
  );
}
