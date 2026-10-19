// Client-side view of a room: applies server messages, predicts the local player's movement,
// reconciles with authoritative snapshots, and interpolates remote players.

import { MAX_STEP } from '../shared/constants';
import type { Vec } from '../shared/geometry';
import { Maze } from '../shared/maze';
import { isActive, speedFactor, type Effects } from '../shared/perks';
import { clampStep, moveCircle, moveFree, settle } from '../shared/physics';
import type {
  ClientMsg,
  EntityState,
  ItemState,
  Phase,
  PlayerInfo,
  RoomSettings,
  RoundTimings,
  ServerMsg,
} from '../shared/protocol';
import type { Transport } from './transport';

export type EndInfo = Extract<ServerMsg, { t: 'end' }>;

export interface SessionListener {
  welcome(): void;
  room(): void;
  round(): void;
  caught(msg: Extract<ServerMsg, { t: 'caught' }>): void;
  hint(angle: number): void;
  /** Someone took a pickup (whoever it was: `by`). */
  pickup(msg: Extract<ServerMsg, { t: 'pickup' }>): void;
  end(info: EndInfo): void;
  error(msg: string): void;
  closed(reason: string): void;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

interface Remote {
  samples: Sample[];
  /** Server time at which the player dropped out of view, if they have. */
  goneAt: number | null;
}

interface PendingInput {
  s: number;
  x: number;
  y: number;
  /** Predicted as passing through walls. */
  phase: boolean;
}

/** Snapping instead of smoothing above this correction distance (e.g. a new round). */
const SNAP_DISTANCE = 60;
/** Release margin so the seeker never predicts movement the server will reject. */
const RELEASE_MARGIN_MS = 50;

export class Session {
  myId = '';
  code = '';
  solo = false;
  /** Takes back our place after a reload or a dropped connection (multiplayer only). */
  token: string | null = null;
  hostId: string | null = null;
  status: 'lobby' | 'playing' = 'lobby';
  players: PlayerInfo[] = [];
  settings: RoomSettings = { hunt: 90, hints: 12, reveal: 3 };

  round = 0;
  maze: Maze | null = null;
  seekerId = '';
  roundStart = 0;
  timings: RoundTimings = { reveal: 3000, fade: 2000, hunt: 90000 };
  participating = false;
  caught = false;
  spectating: string | null = null;
  serverPhase: Phase = 'lobby';
  phaseEnd = 0;
  alive = 0;
  total = 0;
  lastEnd: EndInfo | null = null;
  /** Pickups in the maze, by id. */
  items = new Map<number, ItemState>();
  /** Effects on the player whose view we have (ourselves, or whoever we watch), by end time. */
  effects: Effects = {};
  /** Opponents shown wherever they are, by the radar or a beacon. */
  marks: EntityState[] = [];

  /** Predicted local position at the latest tick, and at the tick before (for render interpolation). */
  pos: Vec = { x: 0, y: 0 };
  prevPos: Vec = { x: 0, y: 0 };
  /** Visual offset left over from reconciliation; decays to zero so corrections are smooth. */
  correction: Vec = { x: 0, y: 0 };
  private pending: PendingInput[] = [];
  private seq = 0;
  private phasing = false;

  private remotes = new Map<string, Remote>();
  private clockOffset = 0;
  private clockSamples: { rtt: number; offset: number }[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  readonly interpDelay: number;

  constructor(
    private readonly transport: Transport,
    private readonly listener: SessionListener,
  ) {
    this.interpDelay = transport.local ? 50 : 100;
    transport.onMessage = (msg) => this.receive(msg);
    transport.onClose = (reason) => {
      this.stopPings();
      listener.closed(reason);
    };
  }

  send(msg: ClientMsg): void {
    this.transport.send(msg);
  }

  /** Leaves the room for good. (A dropped connection instead holds our place for a while.) */
  leave(): void {
    this.transport.send({ t: 'leave' });
    this.stopPings();
    this.transport.close();
  }

  get isHost(): boolean {
    return this.hostId === this.myId;
  }

  get isSeeker(): boolean {
    return this.seekerId === this.myId;
  }

  playerInfo(id: string): PlayerInfo | undefined {
    return this.players.find((p) => p.id === id);
  }

  /** Estimated current server time. */
  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  /** Phase at the given server time, derived locally from the round schedule for smooth transitions. */
  phaseAt(t = this.serverNow()): Phase {
    if (this.serverPhase === 'lobby' || this.serverPhase === 'ended') return this.serverPhase;
    const elapsed = t - this.roundStart;
    if (elapsed < this.timings.reveal) return 'reveal';
    if (elapsed < this.timings.reveal + this.timings.fade) return 'fade';
    return 'hunt';
  }

  get releaseAt(): number {
    return this.roundStart + this.timings.reveal + this.timings.fade;
  }

  /** Time left in the hunt at the given server time: all of it before the hunt, none once the round ends. */
  huntLeft(t = this.serverNow()): number {
    const phase = this.phaseAt(t);
    if (phase === 'ended') return 0;
    if (phase !== 'hunt') return this.timings.hunt;
    // phaseAt() reaches the hunt on our own clock, before the server's first hunt snapshot
    // arrives. Until then phaseEnd is still the end of the fade, so go by the round schedule.
    const end = this.serverPhase === 'hunt' ? this.phaseEnd : this.releaseAt + this.timings.hunt;
    return end - t;
  }

  canMoveNow(): boolean {
    if (!this.maze || !this.participating || this.caught) return false;
    const phase = this.phaseAt();
    if (phase === 'hunt') return !this.isSeeker || this.serverNow() >= this.releaseAt + RELEASE_MARGIN_MS;
    return (phase === 'reveal' || phase === 'fade') && !this.isSeeker;
  }

  /** Whether an effect is running on the player whose view we have. */
  hasEffect(kind: keyof Effects, t = this.serverNow()): boolean {
    return isActive(this.effects, kind, t);
  }

  /** Longest step one input tick may take now, with any speed boost or slow applied. */
  maxStep(t = this.serverNow()): number {
    return MAX_STEP * speedFactor(this.effects, t);
  }

  /** One fixed 60 Hz input tick: predict locally, then send the same input to the server. */
  tick(move: Vec): void {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    if (!this.maze || !this.canMoveNow()) return;
    const now = this.serverNow();
    // Like the server: nobody stays inside a wall once their phase ends.
    const phasing = this.hasEffect('phase', now);
    if (this.phasing && !phasing) settle(this.maze, this.pos);
    this.phasing = phasing;
    const step = clampStep(move.x, move.y, this.maxStep(now));
    if (step.x === 0 && step.y === 0) return;
    const input = { s: ++this.seq, x: step.x, y: step.y, phase: phasing };
    this.pending.push(input);
    stepFrom(this.maze, this.pos, input);
    this.transport.send({ t: 'input', r: this.round, s: input.s, x: input.x, y: input.y });
  }

  /** Local player's position to draw, interpolated between ticks and smoothed after corrections. */
  renderPos(alpha: number, dt: number): Vec {
    const decay = Math.exp(-dt / 90);
    this.correction.x *= decay;
    this.correction.y *= decay;
    return {
      x: this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha + this.correction.x,
      y: this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha + this.correction.y,
    };
  }

  /** Interpolated positions of the remote players currently in view. */
  remotePositions(): Map<string, Vec> {
    const t = this.serverNow() - this.interpDelay;
    const out = new Map<string, Vec>();
    for (const [id, r] of this.remotes) {
      if (r.goneAt !== null && t >= r.goneAt) {
        if (t - r.goneAt > 2000) this.remotes.delete(id);
        continue;
      }
      const s = r.samples;
      if (s.length === 0 || t < s[0].t) continue;
      let i = s.length - 1;
      while (i > 0 && s[i - 1].t > t) i--;
      const b = s[i];
      const a = i > 0 ? s[i - 1] : b;
      if (t >= b.t || a === b) {
        out.set(id, { x: b.x, y: b.y });
      } else {
        const k = (t - a.t) / (b.t - a.t);
        out.set(id, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.code = msg.code;
        this.solo = msg.solo;
        this.token = msg.token ?? null;
        this.startPings();
        this.listener.welcome();
        break;
      case 'room':
        this.hostId = msg.hostId;
        this.status = msg.status;
        this.players = msg.players;
        this.settings = msg.settings;
        if (msg.status === 'lobby') {
          this.serverPhase = 'lobby';
          this.maze = null;
          this.participating = false;
        }
        this.listener.room();
        break;
      case 'round':
        this.onRound(msg);
        break;
      case 'snap':
        this.onSnapshot(msg);
        break;
      case 'caught':
        if (msg.id === this.myId) {
          this.caught = true;
          this.pending = [];
        }
        this.listener.caught(msg);
        break;
      case 'hint':
        this.listener.hint(msg.a);
        break;
      case 'item':
        this.items.set(msg.item.id, msg.item);
        break;
      case 'pickup':
        this.items.delete(msg.id);
        // Use what we got at once rather than waiting for the next snapshot to say so.
        if (msg.by === this.myId && msg.fx && msg.u !== undefined) this.effects = { ...this.effects, [msg.fx]: msg.u };
        this.listener.pickup(msg);
        break;
      case 'end':
        this.serverPhase = 'ended';
        this.lastEnd = msg;
        this.phaseEnd = msg.next ?? this.serverNow();
        this.listener.end(msg);
        break;
      case 'pong':
        this.onPong(msg.c, msg.s);
        break;
      case 'error':
        this.listener.error(msg.msg);
        break;
    }
  }

  private onRound(msg: Extract<ServerMsg, { t: 'round' }>): void {
    this.round = msg.n;
    this.maze = Maze.fromData(msg.maze);
    this.seekerId = msg.seekerId;
    this.roundStart = msg.start;
    this.timings = msg.timings;
    this.serverPhase = 'reveal';
    this.phaseEnd = msg.start + msg.timings.reveal;
    this.participating = msg.you !== null;
    this.caught = msg.caught ?? false;
    this.spectating = null;
    this.lastEnd = null;
    this.pending = [];
    this.remotes.clear();
    this.correction = { x: 0, y: 0 };
    this.items = new Map(msg.items.map((i) => [i.id, i]));
    this.effects = {};
    this.marks = [];
    this.phasing = false;
    if (msg.you) {
      this.pos = { ...msg.you };
      this.prevPos = { ...msg.you };
    }
    this.listener.round();
  }

  private onSnapshot(msg: Extract<ServerMsg, { t: 'snap' }>): void {
    if (msg.ph === 'lobby') return;
    if (this.clockSamples.length === 0) this.clockOffset = msg.st - performance.now();
    if (this.serverPhase !== 'ended' || msg.ph === 'ended') this.serverPhase = msg.ph;
    this.phaseEnd = msg.pe;
    this.alive = msg.alive;
    this.total = msg.total;
    this.spectating = msg.view ?? null;
    this.effects = msg.fx ?? {};
    this.marks = msg.m ?? [];
    if (msg.you && this.maze && !this.caught) this.reconcile(msg.you);
    this.updateRemotes(msg.st, msg.o);
  }

  /** Rewinds to the server's position and replays inputs the server has not processed yet. */
  private reconcile(you: { x: number; y: number; s: number }): void {
    const maze = this.maze!;
    this.pending = this.pending.filter((p) => p.s > you.s);
    const next = { x: you.x, y: you.y };
    for (const p of this.pending) stepFrom(maze, next, p);
    const dx = this.pos.x - next.x;
    const dy = this.pos.y - next.y;
    if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.correction = { x: 0, y: 0 };
      this.prevPos = { ...next };
    } else {
      this.correction.x += dx;
      this.correction.y += dy;
      this.prevPos.x -= dx;
      this.prevPos.y -= dy;
    }
    this.pos = next;
  }

  private updateRemotes(st: number, list: EntityState[]): void {
    const seen = new Set<string>();
    for (const e of list) {
      seen.add(e.i);
      let r = this.remotes.get(e.i);
      if (!r) {
        r = { samples: [], goneAt: null };
        this.remotes.set(e.i, r);
      }
      if (r.goneAt !== null) {
        // Reappeared after being out of view: start fresh rather than sliding across the gap.
        r.samples = [];
        r.goneAt = null;
      }
      r.samples.push({ t: st, x: e.x, y: e.y });
      while (r.samples.length > 2 && r.samples[1].t < st - 1000) r.samples.shift();
    }
    for (const [id, r] of this.remotes) {
      if (!seen.has(id) && r.goneAt === null) r.goneAt = st;
    }
  }

  private startPings(): void {
    this.stopPings();
    let count = 0;
    const ping = () => this.transport.send({ t: 'ping', c: performance.now() });
    ping();
    // A quick burst for a good initial estimate, then a slow refresh.
    this.pingTimer = setInterval(() => {
      ping();
      if (++count === 5 && this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(ping, 2000);
      }
    }, 150);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Clock sync: trust the lowest-latency recent samples, where the one-way estimate is tightest. */
  private onPong(sent: number, serverTime: number): void {
    const now = performance.now();
    const rtt = now - sent;
    this.clockSamples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.clockSamples.length > 12) this.clockSamples.shift();
    const best = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.clockOffset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
  }
}

/** Applies one predicted input: through walls if it was made while phasing. */
function stepFrom(maze: Maze, pos: Vec, input: PendingInput): void {
  if (input.phase) moveFree(maze, pos, input.x, input.y);
  else moveCircle(maze, pos, input.x, input.y);
}
