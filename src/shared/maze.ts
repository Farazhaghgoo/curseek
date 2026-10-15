import { CELL, MAZE_COLS, MAZE_ROWS } from './constants';
import type { Segment, Vec } from './geometry';
import { randInt, shuffle, type Rng } from './rng';

/** Compact, serialisable maze description sent to clients at the start of a round. */
export interface MazeData {
  cols: number;
  rows: number;
  cell: number;
  /** '1'/'0' per horizontal edge: index y * cols + x is the top edge of cell (x, y), y in [0, rows]. */
  h: string;
  /** '1'/'0' per vertical edge: index y * (cols + 1) + x is the left edge of cell (x, y), x in [0, cols]. */
  v: string;
}

export interface GenerateOptions {
  cols?: number;
  rows?: number;
  cell?: number;
  /** Extra openings to add after carving a perfect maze, as a fraction of the cell count. */
  loopFactor?: number;
}

/**
 * A rectangular grid maze. Walls live on cell edges; geometry is derived from the edge
 * bitmaps so every client builds identical collision and sight data from `MazeData`.
 */
export class Maze {
  readonly width: number;
  readonly height: number;
  /** One segment per wall edge, used for collision. */
  readonly edges: Segment[] = [];
  /** Collinear runs of wall edges merged into longer segments, used for sight. */
  readonly runs: Segment[] = [];
  private readonly near: Int32Array[] = [];

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cell: number,
    readonly h: Uint8Array,
    readonly v: Uint8Array,
  ) {
    this.width = cols * cell;
    this.height = rows * cell;
    this.buildGeometry();
  }

  static generate(rng: Rng, opts: GenerateOptions = {}): Maze {
    const cols = opts.cols ?? MAZE_COLS;
    const rows = opts.rows ?? MAZE_ROWS;
    const cell = opts.cell ?? CELL;
    const loopFactor = opts.loopFactor ?? 0.1;
    const h = new Uint8Array((rows + 1) * cols).fill(1);
    const v = new Uint8Array(rows * (cols + 1)).fill(1);
    const maze = new MazeCarver(cols, rows, h, v);
    maze.carveGrowingTree(rng);
    maze.addLoops(rng, Math.round(cols * rows * loopFactor));
    return new Maze(cols, rows, cell, h, v);
  }

  static fromData(d: MazeData): Maze {
    const h = Uint8Array.from(d.h, (c) => (c === '1' ? 1 : 0));
    const v = Uint8Array.from(d.v, (c) => (c === '1' ? 1 : 0));
    if (h.length !== (d.rows + 1) * d.cols || v.length !== d.rows * (d.cols + 1)) {
      throw new Error('Malformed maze data');
    }
    return new Maze(d.cols, d.rows, d.cell, h, v);
  }

  toData(): MazeData {
    return {
      cols: this.cols,
      rows: this.rows,
      cell: this.cell,
      h: Array.from(this.h).join(''),
      v: Array.from(this.v).join(''),
    };
  }

  get cellCount(): number {
    return this.cols * this.rows;
  }

  /** Cell index containing world point (x, y), clamped to the grid. */
  cellAt(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.cols + cx;
  }

  cellCenter(i: number, out: Vec = { x: 0, y: 0 }): Vec {
    out.x = ((i % this.cols) + 0.5) * this.cell;
    out.y = (Math.floor(i / this.cols) + 0.5) * this.cell;
    return out;
  }

  /** Open neighbours of cell i (cells reachable without crossing a wall). */
  neighbours(i: number): number[] {
    const { cols, rows } = this;
    const x = i % cols;
    const y = Math.floor(i / cols);
    const out: number[] = [];
    if (x > 0 && !this.v[y * (cols + 1) + x]) out.push(i - 1);
    if (x < cols - 1 && !this.v[y * (cols + 1) + x + 1]) out.push(i + 1);
    if (y > 0 && !this.h[y * cols + x]) out.push(i - cols);
    if (y < rows - 1 && !this.h[(y + 1) * cols + x]) out.push(i + cols);
    return out;
  }

  /** Breadth-first path lengths (in cells) from `start`; unreachable cells are -1. */
  distancesFrom(start: number): Int32Array {
    const dist = new Int32Array(this.cellCount).fill(-1);
    const queue = new Int32Array(this.cellCount);
    let head = 0;
    let tail = 0;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      for (const n of this.neighbours(c)) {
        if (dist[n] < 0) {
          dist[n] = dist[c] + 1;
          queue[tail++] = n;
        }
      }
    }
    return dist;
  }

  /** Shortest cell path from `from` to `to`, inclusive of both ends. */
  path(from: number, to: number): number[] {
    const prev = new Int32Array(this.cellCount).fill(-1);
    const queue = new Int32Array(this.cellCount);
    let head = 0;
    let tail = 0;
    prev[from] = from;
    queue[tail++] = from;
    while (head < tail && prev[to] < 0) {
      const c = queue[head++];
      for (const n of this.neighbours(c)) {
        if (prev[n] < 0) {
          prev[n] = c;
          queue[tail++] = n;
        }
      }
    }
    if (prev[to] < 0) return [];
    const out = [to];
    for (let c = to; c !== from; c = prev[c]) out.push(prev[c]);
    return out.reverse();
  }

  /** Indices into `edges` of every wall that can touch a small circle centred at (x, y). */
  wallsNear(x: number, y: number): Int32Array {
    return this.near[this.cellAt(x, y)];
  }

  private buildGeometry(): void {
    const { cols, rows, cell, h, v } = this;
    const hIndex = new Int32Array(h.length).fill(-1);
    const vIndex = new Int32Array(v.length).fill(-1);

    for (let y = 0; y <= rows; y++) {
      let runStart = -1;
      for (let x = 0; x <= cols; x++) {
        const wall = x < cols && h[y * cols + x] === 1;
        if (wall) {
          hIndex[y * cols + x] = this.edges.length;
          this.edges.push({ ax: x * cell, ay: y * cell, bx: (x + 1) * cell, by: y * cell });
          if (runStart < 0) runStart = x;
        } else if (runStart >= 0) {
          this.runs.push({ ax: runStart * cell, ay: y * cell, bx: x * cell, by: y * cell });
          runStart = -1;
        }
      }
    }
    for (let x = 0; x <= cols; x++) {
      let runStart = -1;
      for (let y = 0; y <= rows; y++) {
        const wall = y < rows && v[y * (cols + 1) + x] === 1;
        if (wall) {
          vIndex[y * (cols + 1) + x] = this.edges.length;
          this.edges.push({ ax: x * cell, ay: y * cell, bx: x * cell, by: (y + 1) * cell });
          if (runStart < 0) runStart = y;
        } else if (runStart >= 0) {
          this.runs.push({ ax: x * cell, ay: runStart * cell, bx: x * cell, by: y * cell });
          runStart = -1;
        }
      }
    }

    // Each cell's 3x3 neighbourhood covers every edge a circle smaller than half a cell can touch.
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const found: number[] = [];
        for (let y = cy - 1; y <= cy + 2; y++) {
          for (let x = cx - 1; x <= cx + 1; x++) {
            if (y < 0 || y > rows || x < 0 || x >= cols) continue;
            const e = hIndex[y * cols + x];
            if (e >= 0) found.push(e);
          }
        }
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let x = cx - 1; x <= cx + 2; x++) {
            if (y < 0 || y >= rows || x < 0 || x > cols) continue;
            const e = vIndex[y * (cols + 1) + x];
            if (e >= 0) found.push(e);
          }
        }
        this.near.push(Int32Array.from(found));
      }
    }
  }
}

/** Mutable edge bitmaps plus the carving steps used by `Maze.generate`. */
class MazeCarver {
  constructor(
    private readonly cols: number,
    private readonly rows: number,
    private readonly h: Uint8Array,
    private readonly v: Uint8Array,
  ) {}

  /** Growing-tree carving: mostly newest-cell (long corridors) with some random picks (branches). */
  carveGrowingTree(rng: Rng): void {
    const { cols, rows } = this;
    const visited = new Uint8Array(cols * rows);
    const start = randInt(rng, cols * rows);
    const active = [start];
    visited[start] = 1;
    while (active.length > 0) {
      const k = rng() < 0.7 ? active.length - 1 : randInt(rng, active.length);
      const c = active[k];
      const options = shuffle(rng, this.gridNeighbours(c)).filter((n) => !visited[n]);
      if (options.length === 0) {
        active.splice(k, 1);
        continue;
      }
      const n = options[0];
      this.open(c, n);
      visited[n] = 1;
      active.push(n);
    }
  }

  /**
   * Knocks out extra walls between cells that are far apart along the current maze, creating
   * loops that offer real alternative routes. A wall is only removed if both of its end posts
   * stay attached to another wall, which avoids open rooms and floating wall fragments.
   */
  addLoops(rng: Rng, count: number): void {
    const { cols, rows } = this;
    const candidates: [number, number][] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (x < cols - 1 && this.v[y * (cols + 1) + x + 1]) candidates.push([i, i + 1]);
        if (y < rows - 1 && this.h[(y + 1) * cols + x]) candidates.push([i, i + cols]);
      }
    }
    shuffle(rng, candidates);
    let added = 0;
    for (const [a, b] of candidates) {
      if (added >= count) break;
      if (!this.postsSurvive(a, b)) continue;
      if (this.pathLength(a, b, 8) < 8) continue;
      this.open(a, b);
      added++;
    }
  }

  private gridNeighbours(i: number): number[] {
    const { cols, rows } = this;
    const x = i % cols;
    const y = Math.floor(i / cols);
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < cols - 1) out.push(i + 1);
    if (y > 0) out.push(i - cols);
    if (y < rows - 1) out.push(i + cols);
    return out;
  }

  private open(a: number, b: number): void {
    const { cols } = this;
    const lo = Math.min(a, b);
    const x = lo % cols;
    const y = Math.floor(lo / cols);
    if (Math.abs(a - b) === 1) this.v[y * (cols + 1) + x + 1] = 0;
    else this.h[(y + 1) * cols + x] = 0;
  }

  private isOpen(a: number, b: number): boolean {
    const { cols } = this;
    const lo = Math.min(a, b);
    const x = lo % cols;
    const y = Math.floor(lo / cols);
    return Math.abs(a - b) === 1 ? this.v[y * (cols + 1) + x + 1] === 0 : this.h[(y + 1) * cols + x] === 0;
  }

  /** Number of walls meeting at grid vertex (vx, vy). */
  private wallsAtVertex(vx: number, vy: number): number {
    const { cols, rows, h, v } = this;
    let n = 0;
    if (vx > 0 && h[vy * cols + vx - 1]) n++;
    if (vx < cols && h[vy * cols + vx]) n++;
    if (vy > 0 && v[(vy - 1) * (cols + 1) + vx]) n++;
    if (vy < rows && v[vy * (cols + 1) + vx]) n++;
    return n;
  }

  private postsSurvive(a: number, b: number): boolean {
    const { cols } = this;
    const lo = Math.min(a, b);
    const x = lo % cols;
    const y = Math.floor(lo / cols);
    // Vertical wall between (x, y) and (x+1, y) runs from vertex (x+1, y) to (x+1, y+1);
    // horizontal wall between (x, y) and (x, y+1) runs from (x, y+1) to (x+1, y+1).
    const [p, q] =
      Math.abs(a - b) === 1
        ? [
            [x + 1, y],
            [x + 1, y + 1],
          ]
        : [
            [x, y + 1],
            [x + 1, y + 1],
          ];
    return this.wallsAtVertex(p[0], p[1]) > 1 && this.wallsAtVertex(q[0], q[1]) > 1;
  }

  /** BFS path length from a to b, giving up (returning `limit`) once the search passes it. */
  private pathLength(a: number, b: number, limit: number): number {
    const dist = new Map<number, number>([[a, 0]]);
    const queue = [a];
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head];
      const d = dist.get(c)!;
      if (c === b) return d;
      if (d >= limit) return limit;
      for (const n of this.gridNeighbours(c)) {
        if (!dist.has(n) && this.isOpen(c, n)) {
          dist.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    return limit;
  }
}
