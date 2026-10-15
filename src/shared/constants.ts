// World geometry and game tuning. Everything here is in world units, which are
// independent of screen size: every client simulates and collides in this space.

export const CELL = 40;
export const MAZE_COLS = 25;
export const MAZE_ROWS = 14;
export const WORLD_WIDTH = MAZE_COLS * CELL;
export const WORLD_HEIGHT = MAZE_ROWS * CELL;

/** Walls are line segments drawn and collided with this half-thickness. */
export const WALL_HALF = 2.5;
/** Players collide as circles of this radius. */
export const PLAYER_RADIUS = 7;

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
/** Maximum player speed in world units per second. */
export const MAX_SPEED = 190;
/** Maximum displacement a single input tick may request. */
export const MAX_STEP = MAX_SPEED / TICK_RATE;

/** Radius of the lit area around a player. */
export const VIEW_RADIUS = 115;
/** Centre distance at which the seeker touches a hider. */
export const CATCH_DISTANCE = PLAYER_RADIUS * 2 + 2;

export const SNAPSHOT_RATE = 30;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const MAX_NAME_LENGTH = 16;

export interface Timings {
  revealMs: number;
  fadeMs: number;
  huntMs: number;
  hintEveryMs: number;
  intermissionMs: number;
  /** How long a dropped player's place is held for them to resume it. */
  reconnectGraceMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  revealMs: 3000,
  fadeMs: 2000,
  huntMs: 90000,
  hintEveryMs: 12000,
  intermissionMs: 6000,
  reconnectGraceMs: 10000,
};

export const SEEKER_COLOR = '#ff4d6d';
export const PLAYER_COLORS = ['#5ef2ff', '#b6ff5e', '#ffd75e', '#c08bff', '#ff9ad5', '#7cffc4'];
