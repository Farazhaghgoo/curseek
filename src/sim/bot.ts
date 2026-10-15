// Simple bot players. A bot only decides on a desired movement each tick; the room applies it
// with the same speed cap and collision code as human input. Bots know the maze layout (they
// saw the reveal like everyone else) but only perceive opponents through the same
// line-of-sight test players are subject to.

import { MAX_STEP, VIEW_RADIUS } from '../shared/constants';
import type { Vec } from '../shared/geometry';
import type { Maze } from '../shared/maze';
import type { Rng } from '../shared/rng';
import { lineOfSight, pathClear } from '../shared/visibility';

/** Bots notice opponents slightly inside the lit radius, roughly where a human would spot them. */
export const BOT_SIGHT = VIEW_RADIUS * 0.85;

export interface BotView {
  maze: Maze;
  now: number;
  role: 'seeker' | 'hider';
  pos: Vec;
  canMove: boolean;
  /** Opponents currently in sight. */
  seen: Vec[];
  /** The seeker's latest direction hint. */
  hint: { angle: number; at: number } | null;
}

const ZERO: Vec = { x: 0, y: 0 };

export class BotBrain {
  private maze: Maze | null = null;
  /** Remaining waypoints (cell centres) followed by the final goal point. */
  private route: Vec[] = [];
  private goal: Vec | null = null;
  private speed = 0.85;
  private replanAt = 0;

  /** Seeker: when each cell was last in view. */
  private seenAt = new Float64Array(0);
  private scanAt = 0;
  private hintUsed = 0;

  /** Last sighting of an opponent: the hider being chased, or the seeker being fled. */
  private sighting: { x: number; y: number; at: number } | null = null;
  private alerted = false;
  private reactAt = 0;

  /** Hider: when it gets restless and moves to another hiding spot. */
  private settleUntil = 0;
  private fidgetAt = 0;

  private lastPos: Vec = { x: 0, y: 0 };
  private stuckTicks = 0;
  private readonly wobble: number;

  constructor(private readonly rng: Rng) {
    this.wobble = rng() * Math.PI * 2;
  }

  private reset(maze: Maze): void {
    this.maze = maze;
    this.route = [];
    this.goal = null;
    this.seenAt = new Float64Array(maze.cellCount).fill(-1e12);
    this.sighting = null;
    this.alerted = false;
    this.replanAt = 0;
    this.settleUntil = 0;
    this.stuckTicks = 0;
  }

  /** Returns the desired displacement for this tick. */
  step(v: BotView): Vec {
    if (v.maze !== this.maze) this.reset(v.maze);
    if (v.role === 'seeker') this.thinkSeeker(v);
    else this.thinkHider(v);
    if (!v.canMove) return ZERO;
    return this.steer(v);
  }

  // ---------------------------------------------------------------------------------------
  // Seeker

  private thinkSeeker(v: BotView): void {
    this.scanCells(v);
    const target = nearest(v.pos, v.seen);
    if (target) {
      if (!this.alerted) {
        this.alerted = true;
        this.reactAt = v.now + 150 + this.rng() * 200;
      }
      this.sighting = { x: target.x, y: target.y, at: v.now };
      if (v.now >= this.reactAt && (v.now >= this.replanAt || !this.goal)) {
        this.speed = 0.96;
        if (pathClear(v.maze, v.pos.x, v.pos.y, target.x, target.y)) this.setDirectGoal(target);
        else this.planTo(v, target);
        this.replanAt = v.now + 200;
      }
      return;
    }
    this.alerted = false;

    if (this.sighting && v.now - this.sighting.at < 5000) {
      // Lost them: check where they were last seen.
      if (dist(v.pos, this.sighting) < 10) {
        this.sighting = null;
        this.goal = null;
      } else if (!this.goal || dist(this.goal, this.sighting) > 1) {
        this.speed = 0.92;
        this.planTo(v, this.sighting);
      }
      return;
    }
    this.sighting = null;

    const newHint = v.hint && v.hint.at > this.hintUsed;
    if (!this.goal || this.reached(v.pos) || v.now >= this.replanAt || newHint) {
      if (v.hint) this.hintUsed = v.hint.at;
      this.planExplore(v);
    }
  }

  /** Marks cells the seeker can currently see into. */
  private scanCells(v: BotView): void {
    if (v.now < this.scanAt) return;
    this.scanAt = v.now + 150;
    const { maze, pos } = v;
    const r = Math.ceil(BOT_SIGHT / maze.cell);
    const cx = Math.floor(pos.x / maze.cell);
    const cy = Math.floor(pos.y / maze.cell);
    const c: Vec = { x: 0, y: 0 };
    for (let y = Math.max(0, cy - r); y <= Math.min(maze.rows - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(maze.cols - 1, cx + r); x++) {
        const i = y * maze.cols + x;
        maze.cellCenter(i, c);
        if (dist(pos, c) <= BOT_SIGHT && lineOfSight(maze, pos.x, pos.y, c.x, c.y)) this.seenAt[i] = v.now;
      }
    }
  }

  /** Heads for cells not seen for a while, nearer ones first, biased toward the latest hint. */
  private planExplore(v: BotView): void {
    const { maze } = v;
    const dist = maze.distancesFrom(maze.cellAt(v.pos.x, v.pos.y));
    const hint = v.hint && v.now - v.hint.at < 9000 ? v.hint : null;
    const c: Vec = { x: 0, y: 0 };
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < maze.cellCount; i++) {
      if (dist[i] < 2) continue;
      const stale = Math.min(40_000, v.now - this.seenAt[i]) / 1000;
      if (stale < 4) continue;
      let score = stale - dist[i] * 0.45 + this.rng() * 4;
      if (hint) {
        maze.cellCenter(i, c);
        score += Math.cos(Math.atan2(c.y - v.pos.y, c.x - v.pos.x) - hint.angle) * 14;
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) best = Math.floor(this.rng() * maze.cellCount);
    this.speed = 0.88;
    this.planTo(v, maze.cellCenter(best));
    this.replanAt = v.now + 6000;
  }

  // ---------------------------------------------------------------------------------------
  // Hider

  private thinkHider(v: BotView): void {
    const seeker = nearest(v.pos, v.seen);
    if (seeker) {
      if (!this.alerted) {
        this.alerted = true;
        this.reactAt = v.now + 120 + this.rng() * 250;
      }
      this.sighting = { x: seeker.x, y: seeker.y, at: v.now };
      if (v.now >= this.reactAt && (v.now >= this.replanAt || !this.goal || this.reached(v.pos))) {
        this.planFlee(v, seeker);
      }
      return;
    }
    this.alerted = false;

    if (this.sighting) {
      if (v.now - this.sighting.at < 2500) {
        if (!this.goal || this.reached(v.pos)) this.planFlee(v, this.sighting);
        return;
      }
      // Calmed down: find a new spot away from where the seeker was.
      const avoid = this.sighting;
      this.sighting = null;
      this.planHide(v, avoid);
      return;
    }

    if (!this.goal) {
      this.planHide(v, null);
    } else if (this.reached(v.pos)) {
      if (v.now >= this.settleUntil) this.planHide(v, null);
      else if (v.now >= this.fidgetAt) this.fidget(v);
    }
  }

  /** Runs toward cells it can reach well before the seeker, preferring junctions (escape routes). */
  private planFlee(v: BotView, from: Vec): void {
    const { maze } = v;
    const here = maze.cellAt(v.pos.x, v.pos.y);
    const dSeeker = maze.distancesFrom(maze.cellAt(from.x, from.y));
    const dMe = maze.distancesFrom(here);
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < maze.cellCount; i++) {
      if (dMe[i] < 2 || dMe[i] > 12) continue;
      const lead = dSeeker[i] - dMe[i];
      let score = lead * 1.2 + dSeeker[i] * 0.4 + this.rng() * 1.5;
      if (lead <= 0) score -= 20;
      if (maze.neighbours(i).length >= 3) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    this.speed = 0.97;
    this.planTo(v, maze.cellCenter(best));
    this.replanAt = v.now + 700;
  }

  /** Picks a hiding spot a moderate walk away, liking dead ends and distance from `avoid`. */
  private planHide(v: BotView, avoid: Vec | null): void {
    const { maze } = v;
    const dMe = maze.distancesFrom(maze.cellAt(v.pos.x, v.pos.y));
    const dAvoid = avoid ? maze.distancesFrom(maze.cellAt(avoid.x, avoid.y)) : null;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < maze.cellCount; i++) {
      if (dMe[i] < 3 || dMe[i] > 18) continue;
      let score = this.rng() * 4 - dMe[i] * 0.05;
      if (maze.neighbours(i).length === 1) score += 2;
      if (dAvoid) score += Math.min(dAvoid[i], 16) * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    this.speed = 0.78;
    this.planTo(v, maze.cellCenter(best));
    this.settleUntil = v.now + 15_000 + this.rng() * 25_000;
    this.fidgetAt = 0;
  }

  /** Small idle shuffles inside the current cell, like a person nudging their mouse. */
  private fidget(v: BotView): void {
    const centre = v.maze.cellCenter(v.maze.cellAt(v.pos.x, v.pos.y));
    this.setDirectGoal({ x: centre.x + (this.rng() - 0.5) * 14, y: centre.y + (this.rng() - 0.5) * 14 });
    this.speed = 0.3;
    this.fidgetAt = v.now + 1200 + this.rng() * 3000;
  }

  // ---------------------------------------------------------------------------------------
  // Movement

  private planTo(v: BotView, point: Vec): void {
    const { maze } = v;
    const cells = maze.path(maze.cellAt(v.pos.x, v.pos.y), maze.cellAt(point.x, point.y));
    this.route = cells.map((c) => maze.cellCenter(c));
    this.route.push({ x: point.x, y: point.y });
    this.goal = { x: point.x, y: point.y };
  }

  private setDirectGoal(point: Vec): void {
    this.route = [{ x: point.x, y: point.y }];
    this.goal = { x: point.x, y: point.y };
  }

  private reached(pos: Vec): boolean {
    return this.goal !== null && this.route.length <= 1 && dist(pos, this.goal) < 4;
  }

  /** Follows the route, cutting corners only where the whole body fits through. */
  private steer(v: BotView): Vec {
    const { maze, pos } = v;
    if (this.route.length === 0) return ZERO;

    let k = 0;
    for (let i = Math.min(4, this.route.length - 1); i > 0; i--) {
      if (pathClear(maze, pos.x, pos.y, this.route[i].x, this.route[i].y)) {
        k = i;
        break;
      }
    }
    if (k > 0) this.route.splice(0, k);
    let target = this.route[0];
    if (this.route.length > 1 && dist(pos, target) < 3) {
      this.route.shift();
      target = this.route[0];
    }

    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) return ZERO;

    // Stuck against something (should be rare): drop the plan and pick a new one.
    if (dist(pos, this.lastPos) < 0.05) {
      if (++this.stuckTicks > 30) {
        this.stuckTicks = 0;
        this.goal = null;
        this.route = [];
        this.replanAt = 0;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastPos = { x: pos.x, y: pos.y };

    const len = Math.min(d, MAX_STEP * this.speed);
    const sway = Math.sin(v.now / 380 + this.wobble) * 0.12;
    const cos = Math.cos(sway);
    const sin = Math.sin(sway);
    const ux = dx / d;
    const uy = dy / d;
    return { x: (ux * cos - uy * sin) * len, y: (ux * sin + uy * cos) * len };
  }
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearest(from: Vec, list: Vec[]): Vec | null {
  let best: Vec | null = null;
  let bestD = Infinity;
  for (const p of list) {
    const d = dist(from, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
