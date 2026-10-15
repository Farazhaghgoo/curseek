// Canvas 2D renderer. The world is scaled to fit the viewport; nothing here affects game state.

import { PLAYER_RADIUS, SEEKER_COLOR, VIEW_RADIUS, WALL_HALF, WORLD_HEIGHT, WORLD_WIDTH } from '../shared/constants';
import type { Vec } from '../shared/geometry';
import type { Maze } from '../shared/maze';
import { visibilityPolygon } from '../shared/visibility';

export interface DrawPlayer {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
  seeker: boolean;
  /** Lost connection: drawn faded until they are back. */
  away?: boolean;
}

export interface Ripple {
  x: number;
  y: number;
  color: string;
  /** Milliseconds since the effect started. */
  age: number;
}

export interface Frame {
  /** Animation clock in milliseconds. */
  time: number;
  /** Opacity of the fully revealed maze (opening reveal, fade, and round results). */
  mazeAlpha: number;
  /** Centre of the lit area, if any. */
  light: Vec | null;
  /** Other players. Drawn only inside the light, unless `showAll`. */
  others: DrawPlayer[];
  /** The local player's cursor, always drawn on top. */
  self: DrawPlayer | null;
  showAll: boolean;
  hint: { angle: number; age: number } | null;
  ripples: Ripple[];
  reducedMotion: boolean;
}

const BG = '#05060a';
const FLOOR = '#0b1120';
const MARGIN = 12;
const MARGIN_TOP = 46;
const HINT_MS = 1600;
const RIPPLE_MS = 900;

export class Renderer {
  /** CSS pixels per world unit. */
  scale = 1;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private width: number = WORLD_WIDTH;
  private height: number = WORLD_HEIGHT;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mazeLayer = document.createElement('canvas');
  private readonly lightLayer = document.createElement('canvas');
  private maze: Maze | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  setMaze(maze: Maze | null): void {
    this.maze = maze;
    if (maze) {
      this.width = maze.width;
      this.height = maze.height;
    }
    this.resize();
  }

  /** Fits the world into the window. World geometry is unaffected; only the view transform changes. */
  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.scale = Math.max(0.05, Math.min((w - 2 * MARGIN) / this.width, (h - MARGIN_TOP - MARGIN) / this.height));
    this.ox = (w - this.width * this.scale) / 2;
    this.oy = MARGIN_TOP + (h - MARGIN_TOP - MARGIN - this.height * this.scale) / 2;
    this.buildMazeLayer();
  }

  draw(f: Frame): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.maze) return;

    if (f.mazeAlpha > 0) {
      ctx.globalAlpha = f.mazeAlpha;
      ctx.drawImage(this.mazeLayer, 0, 0);
      ctx.globalAlpha = 1;
    }

    if (f.showAll) {
      this.worldTransform(ctx);
      for (const p of f.others) this.drawPlayer(ctx, p, f, 1);
    } else if (f.light) {
      this.drawLight(f.light, f);
      if (f.hint) this.drawHint(f.light, f.hint, f.reducedMotion);
    }

    this.worldTransform(ctx);
    for (const r of f.ripples) this.drawRipple(r, f.reducedMotion);
    if (f.self) this.drawPlayer(ctx, f.self, f, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------------------------------------------------------------------------------------

  private worldTransform(ctx: CanvasRenderingContext2D, offsetX = 0, offsetY = 0): void {
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, this.ox * this.dpr - offsetX, this.oy * this.dpr - offsetY);
  }

  /** Pre-renders the glowing walls once per maze/resize; per-frame drawing just copies it. */
  private buildMazeLayer(): void {
    const layer = this.mazeLayer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext('2d')!;
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (!this.maze) return;
    this.worldTransform(ctx);
    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, 0, this.maze.width, this.maze.height);

    const path = new Path2D();
    for (const s of this.maze.runs) {
      path.moveTo(s.ax, s.ay);
      path.lineTo(s.bx, s.by);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(80, 170, 255, 0.85)';
    ctx.shadowBlur = 14 * this.dpr;
    ctx.strokeStyle = '#7cc8ff';
    ctx.lineWidth = WALL_HALF * 2;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#e8f6ff';
    ctx.lineWidth = WALL_HALF * 0.7;
    ctx.stroke(path);
  }

  /**
   * Draws the area visible from `origin`: the maze and nearby players, masked by the
   * wall-clipped visibility polygon with a soft radial falloff. Work is confined to a small
   * offscreen canvas around the light so the cost does not grow with window size.
   */
  private drawLight(origin: Vec, f: Frame): void {
    const maze = this.maze!;
    const k = this.scale * this.dpr;
    const radius = VIEW_RADIUS;
    const pad = 10;
    const size = Math.ceil((radius + pad) * 2 * k);
    const layer = this.lightLayer;
    if (layer.width !== size || layer.height !== size) {
      layer.width = size;
      layer.height = size;
    }
    const left = Math.floor((this.ox + (origin.x - radius - pad) * this.scale) * this.dpr);
    const top = Math.floor((this.oy + (origin.y - radius - pad) * this.scale) * this.dpr);

    const lctx = layer.getContext('2d')!;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, size, size);
    lctx.drawImage(this.mazeLayer, left, top, size, size, 0, 0, size, size);

    this.worldTransform(lctx, left, top);
    const glow = lctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, radius);
    glow.addColorStop(0, 'rgba(120, 175, 255, 0.16)');
    glow.addColorStop(1, 'rgba(120, 175, 255, 0)');
    lctx.globalCompositeOperation = 'lighter';
    lctx.fillStyle = glow;
    lctx.fillRect(origin.x - radius, origin.y - radius, radius * 2, radius * 2);
    lctx.globalCompositeOperation = 'source-over';

    for (const p of f.others) this.drawPlayer(lctx, p, f, 1);

    const poly = visibilityPolygon(maze, origin.x, origin.y, radius);
    const mask = new Path2D();
    mask.moveTo(poly[0], poly[1]);
    for (let i = 2; i < poly.length; i += 2) mask.lineTo(poly[i], poly[i + 1]);
    mask.closePath();
    const falloff = lctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, radius);
    falloff.addColorStop(0, 'rgba(0,0,0,1)');
    falloff.addColorStop(0.55, 'rgba(0,0,0,0.92)');
    falloff.addColorStop(0.85, 'rgba(0,0,0,0.4)');
    falloff.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.globalCompositeOperation = 'destination-in';
    lctx.fillStyle = falloff;
    lctx.fill(mask);
    lctx.globalCompositeOperation = 'source-over';

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(layer, left, top);
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: DrawPlayer, f: Frame, alpha: number): void {
    ctx.save();
    ctx.globalAlpha = p.away ? alpha * 0.4 : alpha;
    if (p.seeker) drawSeeker(ctx, p.x, p.y, p.color, f.time, f.reducedMotion, this.dpr);
    else drawArrow(ctx, p.x, p.y, p.color, this.dpr);
    if (p.name && p !== f.self) {
      ctx.font = `${11 / this.scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(220, 230, 255, 0.75)';
      ctx.fillText(p.away ? `${p.name} (away)` : p.name, p.x, p.y + PLAYER_RADIUS + 14 / this.scale);
    }
    ctx.restore();
  }

  /** A soft arc on the edge of the seeker's light pointing roughly toward the nearest hider. */
  private drawHint(origin: Vec, hint: { angle: number; age: number }, reduced: boolean): void {
    if (hint.age > HINT_MS) return;
    const t = hint.age / HINT_MS;
    const alpha = reduced ? (t < 0.8 ? 0.7 : (1 - t) * 3.5) : Math.sin(Math.PI * Math.min(1, t * 1.1)) * 0.8;
    const ctx = this.ctx;
    this.worldTransform(ctx);
    const r = VIEW_RADIUS * (reduced ? 0.9 : 0.82 + 0.1 * t);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.strokeStyle = SEEKER_COLOR;
    ctx.shadowColor = SEEKER_COLOR;
    ctx.shadowBlur = 16 * this.dpr;
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, r, hint.angle - 0.38, hint.angle + 0.38);
    ctx.stroke();
    ctx.restore();
  }

  private drawRipple(r: Ripple, reduced: boolean): void {
    if (r.age > RIPPLE_MS) return;
    const t = r.age / RIPPLE_MS;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = r.color;
    ctx.shadowColor = r.color;
    ctx.shadowBlur = 12 * this.dpr;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r.x, r.y, reduced ? PLAYER_RADIUS * 2 : PLAYER_RADIUS + t * 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Classic arrow pointer, centred on the player's collision circle. */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, dpr: number): void {
  const s = 17;
  const pts = [0, 0, 0, 1, 0.27, 0.76, 0.45, 1.12, 0.6, 1.05, 0.42, 0.7, 0.74, 0.7];
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const px = x + (pts[i] - 0.3) * s;
    const py = y + (pts[i + 1] - 0.55) * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 10 * dpr;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(5, 6, 10, 0.85)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/** Crosshair reticle: unmistakably the seeker. */
function drawSeeker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  accent: string,
  time: number,
  reduced: boolean,
  dpr: number,
): void {
  const r = PLAYER_RADIUS + 1.5;
  if (!reduced) {
    const pulse = (time % 1400) / 1400;
    ctx.beginPath();
    ctx.arc(x, y, r + 2 + pulse * 10, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 77, 109, ${0.45 * (1 - pulse)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.shadowColor = SEEKER_COLOR;
  ctx.shadowBlur = 14 * dpr;
  ctx.strokeStyle = SEEKER_COLOR;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.moveTo(x + dx * (r - 3.5), y + dy * (r - 3.5));
    ctx.lineTo(x + dx * (r + 4), y + dy * (r + 4));
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
}
