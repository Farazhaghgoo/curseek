// Pickups scattered through the maze. Touching a mystery orb gives a random effect for a few
// seconds, drawn from a table that depends on your role: mostly perks, sometimes a curse. Touching
// a coin scores a point. Shared so the client can predict its own movement and size its light.

import { VIEW_RADIUS } from './constants';
import type { Rng } from './rng';

export type EffectKind = 'speed' | 'cloak' | 'radar' | 'flare' | 'phase' | 'slow' | 'blind' | 'beacon';
export type ItemKind = 'orb' | 'coin';

/** Active effects: the server time each one ends. */
export type Effects = Partial<Record<EffectKind, number>>;

export interface EffectInfo {
  name: string;
  /** What it does to whoever picked it up. */
  blurb: string;
  ms: number;
  curse: boolean;
  /** Relative chance of rolling it from an orb, per role (0: never). */
  weight: { seeker: number; hider: number };
}

export const EFFECTS: Record<EffectKind, EffectInfo> = {
  speed: { name: 'Speed boost', blurb: 'you move faster', ms: 5000, curse: false, weight: { seeker: 3, hider: 3 } },
  cloak: { name: 'Cloak', blurb: 'the seeker cannot see you', ms: 6000, curse: false, weight: { seeker: 0, hider: 3 } },
  radar: { name: 'Radar', blurb: 'every hider shows up', ms: 2000, curse: false, weight: { seeker: 3, hider: 0 } },
  flare: { name: 'Flare', blurb: 'your light reaches twice as far', ms: 8000, curse: false, weight: { seeker: 2, hider: 2 } },
  phase: { name: 'Phase', blurb: 'you pass through walls', ms: 4000, curse: false, weight: { seeker: 2, hider: 2 } },
  slow: { name: 'Slow', blurb: 'you move slower', ms: 4000, curse: true, weight: { seeker: 1.5, hider: 1.5 } },
  blind: { name: 'Blind', blurb: 'your light shrinks', ms: 6000, curse: true, weight: { seeker: 1.5, hider: 1.5 } },
  beacon: { name: 'Beacon', blurb: 'the other side sees where you are', ms: 4000, curse: true, weight: { seeker: 1.5, hider: 1.5 } },
};

export const EFFECT_KINDS = Object.keys(EFFECTS) as EffectKind[];

export const SPEED_BOOST = 1.6;
export const SLOW_FACTOR = 0.55;
export const FLARE_FACTOR = 2;
export const BLIND_FACTOR = 0.45;

/** Pickups are touched at this centre distance plus the player's radius. */
export const ITEM_RADIUS = 6;
/** Pickups on the map at once. One taken reappears somewhere else after a delay. */
export const ORB_COUNT = 5;
export const COIN_COUNT = 6;
export const ORB_RESPAWN_MS = 8000;
export const COIN_RESPAWN_MS = 10000;

export function isActive(fx: Effects, kind: EffectKind, now: number): boolean {
  const end = fx[kind];
  return end !== undefined && now < end;
}

/** Multiplier on the maximum speed. */
export function speedFactor(fx: Effects, now: number): number {
  return (isActive(fx, 'speed', now) ? SPEED_BOOST : 1) * (isActive(fx, 'slow', now) ? SLOW_FACTOR : 1);
}

/** Radius of the lit area around a player. */
export function lightRadius(fx: Effects, now: number): number {
  return VIEW_RADIUS * (isActive(fx, 'flare', now) ? FLARE_FACTOR : 1) * (isActive(fx, 'blind', now) ? BLIND_FACTOR : 1);
}

/** The effects still running at `now`. */
export function liveEffects(fx: Effects, now: number): Effects {
  const out: Effects = {};
  for (const k of EFFECT_KINDS) if (isActive(fx, k, now)) out[k] = fx[k];
  return out;
}

/** What a mystery orb gives a player in this role. */
export function rollEffect(rng: Rng, role: 'seeker' | 'hider'): EffectKind {
  const kinds = EFFECT_KINDS.filter((k) => EFFECTS[k].weight[role] > 0);
  let r = rng() * kinds.reduce((sum, k) => sum + EFFECTS[k].weight[role], 0);
  for (const k of kinds) {
    r -= EFFECTS[k].weight[role];
    if (r < 0) return k;
  }
  return kinds[kinds.length - 1];
}
