// Messages exchanged between a client and the authoritative room (over WebSocket, or
// in-memory for solo play). Keep field names short: snapshots are sent 30 times a second.

import { MAX_NAME_LENGTH } from './constants';
import type { MazeData } from './maze';

export type Phase = 'lobby' | 'reveal' | 'fade' | 'hunt' | 'ended';
export type EndReason = 'all-caught' | 'time' | 'seeker-left' | 'not-enough-players';

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'start' }
  | { t: 'addBot' }
  | { t: 'removeBot' }
  /** One input tick: requested displacement (x, y) in world units, for round r, sequence s. */
  | { t: 'input'; r: number; s: number; x: number; y: number }
  | { t: 'ping'; c: number };

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  bot: boolean;
  /** Joined during a round; plays from the next one. */
  waiting: boolean;
}

/** A player position in a snapshot. */
export interface EntityState {
  i: string;
  x: number;
  y: number;
}

export interface RoundTimings {
  reveal: number;
  fade: number;
  hunt: number;
}

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      code: string;
      solo: boolean;
      /** Takes back this place after a reload or a dropped connection (multiplayer only). */
      token?: string;
    }
  | { t: 'room'; code: string; hostId: string | null; status: 'lobby' | 'playing'; players: PlayerInfo[] }
  | {
      t: 'round';
      n: number;
      maze: MazeData;
      seekerId: string;
      /** Your spawn, or null if you are waiting for the next round. */
      you: { x: number; y: number } | null;
      /** Server time the round started (reveal begins). */
      start: number;
      timings: RoundTimings;
      /** Only when resuming mid-round: you had already been caught. */
      caught?: boolean;
    }
  | {
      t: 'snap';
      /** Server time of this snapshot. */
      st: number;
      ph: Phase;
      /** Server time the current phase ends. */
      pe: number;
      alive: number;
      total: number;
      /** Your authoritative position and the last input sequence applied. */
      you?: { x: number; y: number; s: number };
      /** When caught, the id of the player whose view you are watching. */
      view?: string;
      /** Other players you can currently see. Hidden players are never included. */
      o: EntityState[];
    }
  | { t: 'caught'; id: string; by: string; x?: number; y?: number }
  | { t: 'hint'; a: number }
  | {
      t: 'end';
      n: number;
      winner: 'seeker' | 'hiders' | null;
      reason: EndReason;
      seekerId: string;
      caught: string[];
      survivors: string[];
      positions: EntityState[];
      /** Server time the next round starts, or null if the room returns to the lobby. */
      next: number | null;
    }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: 'not-found' | 'full' | 'bad-request' | 'replaced'; msg: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** Validates an untrusted decoded message. Returns null for anything malformed. */
export function parseClientMsg(data: unknown): ClientMsg | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case 'create':
      return typeof m.name === 'string' ? { t: 'create', name: m.name.slice(0, 64) } : null;
    case 'join':
      return typeof m.name === 'string' && typeof m.code === 'string' && m.code.length <= 12
        ? { t: 'join', code: m.code, name: m.name.slice(0, 64) }
        : null;
    case 'start':
    case 'addBot':
    case 'removeBot':
      return { t: m.t };
    case 'input':
      return isInt(m.r) && isInt(m.s) && isNum(m.x) && isNum(m.y) && Math.abs(m.x) < 1e4 && Math.abs(m.y) < 1e4
        ? { t: 'input', r: m.r, s: m.s, x: m.x, y: m.y }
        : null;
    case 'ping':
      return isNum(m.c) ? { t: 'ping', c: m.c } : null;
    default:
      return null;
  }
}

/** Normalises a nickname: printable characters only, collapsed whitespace, bounded length. */
export function cleanName(raw: string): string {
  const name = raw
    .replace(/[\p{C}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return name || 'Player';
}

export function normaliseRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
