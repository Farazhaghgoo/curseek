// The authoritative game simulation for one room. It has no networking or timers of its own:
// a host (the WebSocket server, or the browser in solo mode) feeds it client messages, calls
// update() regularly, and delivers whatever it sends through each player's Sink.

import {
  CATCH_DISTANCE,
  DEFAULT_TIMINGS,
  MAX_PLAYERS,
  MAX_SPEED,
  MAX_STEP,
  MIN_PLAYERS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  SNAPSHOT_RATE,
  TICK_MS,
  VIEW_RADIUS,
  type Timings,
} from '../shared/constants';
import type { Vec } from '../shared/geometry';
import { Maze } from '../shared/maze';
import { clampStep, moveCircle } from '../shared/physics';
import {
  cleanName,
  type ClientMsg,
  type EndReason,
  type EntityState,
  type Phase,
  type PlayerInfo,
  type ServerMsg,
} from '../shared/protocol';
import { mulberry32, randInt, randomSeed, shuffle, type Rng } from '../shared/rng';
import { chooseSpawns } from '../shared/spawn';
import { canSee, lineOfSight } from '../shared/visibility';

export interface Sink {
  send(msg: ServerMsg): void;
}

export interface RoomOptions {
  code: string;
  clock?: () => number;
  seed?: number;
  timings?: Partial<Timings>;
  /** Solo rooms start with a bot as the first seeker. */
  solo?: boolean;
}

export type Role = 'seeker' | 'hider';

interface Player {
  id: string;
  name: string;
  color: string;
  sink: Sink | null;
  isBot: boolean;
  order: number;
  inRound: boolean;
  role: Role;
  caught: boolean;
  pos: Vec;
  /** Last input sequence number received (acknowledged in snapshots). */
  seq: number;
  /** Movement budget (world units) for rate-limiting client inputs. */
  budget: number;
  budgetAt: number;
  /** Latest direction hint (seeker only), kept for bots. */
  hint: { angle: number; at: number } | null;
}

/** How much movement a client may bank, to absorb network jitter without allowing bursts. */
const BUDGET_SECONDS = 0.15;
/** Slack for clock drift between client and server. */
const SPEED_TOLERANCE = 1.05;
/** Players slightly beyond the lit radius are still sent so they fade in smoothly. */
const SEND_RANGE = VIEW_RADIUS + PLAYER_RADIUS + 10;
const BOT_NAMES = ['Echo', 'Nova', 'Blip', 'Wisp', 'Dot', 'Pixel', 'Moth', 'Flick'];

const round2 = (n: number) => Math.round(n * 100) / 100;

export class GameRoom {
  readonly code: string;
  readonly solo: boolean;
  readonly timings: Timings;
  private readonly clock: () => number;
  private readonly rng: Rng;
  private readonly players = new Map<string, Player>();
  private nextOrder = 0;
  private nextId = 1;
  private hostId: string | null = null;

  private phase: Phase = 'lobby';
  private round = 0;
  private maze: Maze | null = null;
  private seekerId = '';
  private lastSeekerOrder = -1;
  private roundStart = 0;
  private phaseEnd = 0;
  private nextHintAt = Infinity;
  private caughtOrder: string[] = [];
  private lastTick = 0;
  private lastSnapshot = -Infinity;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.solo = opts.solo ?? false;
    this.clock = opts.clock ?? (() => performance.now());
    this.rng = mulberry32(opts.seed ?? randomSeed());
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  get status(): 'lobby' | 'playing' {
    return this.phase === 'lobby' ? 'lobby' : 'playing';
  }

  get playerCount(): number {
    return this.players.size;
  }

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  /** Adds a human player. Returns their id, or null if the room is full. */
  addHuman(rawName: string, sink: Sink): string | null {
    if (this.isFull) return null;
    const p = this.createPlayer(`p${this.nextId++}`, cleanName(rawName), sink);
    if (!this.hostId) this.hostId = p.id;
    sink.send({ t: 'welcome', id: p.id, code: this.code, solo: this.solo });
    this.broadcastRoom();
    return p.id;
  }

  addBot(): boolean {
    if (this.isFull) return false;
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.nextId}`;
    this.createPlayer(`b${this.nextId++}`, name, null);
    this.broadcastRoom();
    return true;
  }

  removeBot(): boolean {
    const bots = [...this.players.values()].filter((p) => p.isBot);
    const last = bots.at(-1);
    if (!last) return false;
    this.removePlayer(last.id);
    return true;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.hostId === id) {
      const next = [...this.players.values()].filter((q) => !q.isBot).sort((a, b) => a.order - b.order)[0];
      this.hostId = next?.id ?? null;
    }
    if (p.inRound && this.isLive()) this.onParticipantLeft(p);
    this.broadcastRoom();
  }

  handle(id: string, msg: ClientMsg): void {
    const p = this.players.get(id);
    if (!p) return;
    switch (msg.t) {
      case 'input':
        this.onInput(p, msg.r, msg.s, msg.x, msg.y);
        break;
      case 'ping':
        p.sink?.send({ t: 'pong', c: msg.c, s: this.clock() });
        break;
      case 'start':
        if (id === this.hostId && this.phase === 'lobby' && this.players.size >= MIN_PLAYERS) {
          this.startRound(this.clock());
        }
        break;
      case 'addBot':
        if (id === this.hostId && this.phase === 'lobby') this.addBot();
        break;
      case 'removeBot':
        if (id === this.hostId && this.phase === 'lobby') this.removeBot();
        break;
      default:
        break;
    }
  }

  /** Advances timers, bots and snapshots. Call frequently (every few milliseconds is fine). */
  update(): void {
    const now = this.clock();
    this.advancePhases(now);
    if (this.phase === 'lobby') return;

    let steps = 0;
    while (now - this.lastTick >= TICK_MS && steps < 10) {
      this.lastTick += TICK_MS;
      this.fixedTick();
      steps++;
    }
    if (steps >= 10) this.lastTick = now; // Host stalled; skip ahead rather than fast-forwarding.

    if (now - this.lastSnapshot >= 1000 / SNAPSHOT_RATE - 1) {
      this.lastSnapshot = now;
      this.sendSnapshots(now);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Inspection hooks for tests and tooling. They expose server-side truth, so never forward
  // their results to clients.

  get currentPhase(): Phase {
    return this.phase;
  }

  get currentMaze(): Maze | null {
    return this.maze;
  }

  get currentSeeker(): string {
    return this.seekerId;
  }

  get currentHost(): string | null {
    return this.hostId;
  }

  positionOf(id: string): Vec | null {
    const p = this.players.get(id);
    return p ? { ...p.pos } : null;
  }

  /** Teleports a player (tests only). */
  placePlayer(id: string, x: number, y: number): void {
    const p = this.players.get(id);
    if (p) p.pos = { x, y };
  }

  // ---------------------------------------------------------------------------------------
  // Round flow

  private isLive(): boolean {
    return this.phase === 'reveal' || this.phase === 'fade' || this.phase === 'hunt';
  }

  private advancePhases(now: number): void {
    while (this.phase !== 'lobby' && now >= this.phaseEnd) {
      const at = this.phaseEnd;
      switch (this.phase) {
        case 'reveal':
          this.phase = 'fade';
          this.phaseEnd = at + this.timings.fadeMs;
          break;
        case 'fade':
          this.phase = 'hunt';
          this.phaseEnd = at + this.timings.huntMs;
          this.nextHintAt = at + this.timings.hintEveryMs;
          break;
        case 'hunt':
          this.endRound('hiders', 'time', at);
          break;
        case 'ended':
          if (this.players.size >= MIN_PLAYERS) this.startRound(now);
          else this.returnToLobby();
          break;
      }
    }
  }

  private startRound(now: number): void {
    const participants = [...this.players.values()].sort((a, b) => a.order - b.order);
    const seeker = this.pickSeeker(participants);
    this.round++;
    this.maze = Maze.generate(this.rng);
    this.seekerId = seeker.id;
    this.lastSeekerOrder = seeker.order;

    const hiders = shuffle(
      this.rng,
      participants.filter((p) => p !== seeker),
    );
    const plan = chooseSpawns(this.maze, this.rng, hiders.length);
    for (const p of participants) {
      p.inRound = true;
      p.caught = false;
      p.role = p === seeker ? 'seeker' : 'hider';
      p.budget = MAX_SPEED * BUDGET_SECONDS;
      p.budgetAt = now;
      p.hint = null;
    }
    seeker.pos = this.maze.cellCenter(plan.seeker);
    hiders.forEach((p, i) => (p.pos = this.maze!.cellCenter(plan.hiders[i])));

    this.phase = 'reveal';
    this.roundStart = now;
    this.phaseEnd = now + this.timings.revealMs;
    this.nextHintAt = Infinity;
    this.caughtOrder = [];
    this.lastTick = now;
    this.lastSnapshot = -Infinity;

    const mazeData = this.maze.toData();
    for (const p of participants) {
      p.sink?.send({
        t: 'round',
        n: this.round,
        maze: mazeData,
        seekerId: this.seekerId,
        you: { x: p.pos.x, y: p.pos.y },
        start: this.roundStart,
        timings: { reveal: this.timings.revealMs, fade: this.timings.fadeMs, hunt: this.timings.huntMs },
      });
    }
    this.broadcastRoom();
  }

  /** First round: a random player (a bot in solo play). Later rounds: next player in join order. */
  private pickSeeker(participants: Player[]): Player {
    if (this.lastSeekerOrder < 0) {
      const pool = this.solo ? participants.filter((p) => p.isBot) : participants;
      const from = pool.length > 0 ? pool : participants;
      return from[randInt(this.rng, from.length)];
    }
    return participants.find((p) => p.order > this.lastSeekerOrder) ?? participants[0];
  }

  private endRound(winner: 'seeker' | 'hiders' | null, reason: EndReason, at: number): void {
    if (this.phase === 'ended' || this.phase === 'lobby') return;
    this.phase = 'ended';
    this.phaseEnd = at + this.timings.intermissionMs;
    const participants = [...this.players.values()].filter((p) => p.inRound);
    const survivors = participants.filter((p) => p.role === 'hider' && !p.caught).map((p) => p.id);
    const positions = participants
      .filter((p) => !p.caught)
      .map((p) => ({ i: p.id, x: round2(p.pos.x), y: round2(p.pos.y) }));
    const next = this.players.size >= MIN_PLAYERS ? this.phaseEnd : null;
    for (const p of this.players.values()) {
      p.sink?.send({
        t: 'end',
        n: this.round,
        winner,
        reason,
        seekerId: this.seekerId,
        caught: [...this.caughtOrder],
        survivors,
        positions,
        next,
      });
    }
  }

  private returnToLobby(): void {
    this.phase = 'lobby';
    this.maze = null;
    for (const p of this.players.values()) {
      p.inRound = false;
      p.caught = false;
    }
    this.broadcastRoom();
  }

  private onParticipantLeft(p: Player): void {
    const now = this.clock();
    const participants = [...this.players.values()].filter((q) => q.inRound);
    if (p.id === this.seekerId) {
      this.endRound(null, 'seeker-left', now);
    } else if (participants.length < MIN_PLAYERS) {
      this.endRound(null, 'not-enough-players', now);
    } else if (this.aliveHiders().length === 0) {
      this.endRound(this.caughtOrder.length > 0 ? 'seeker' : null, this.caughtOrder.length > 0 ? 'all-caught' : 'not-enough-players', now);
    }
  }

  private aliveHiders(): Player[] {
    return [...this.players.values()].filter((p) => p.inRound && p.role === 'hider' && !p.caught);
  }

  // ---------------------------------------------------------------------------------------
  // Captures and hints

  /** The seeker catches any hider it touches, provided no wall lies between them. */
  private checkCaptures(): void {
    if (this.phase !== 'hunt' || !this.maze) return;
    const seeker = this.players.get(this.seekerId);
    if (!seeker) return;
    for (const h of this.aliveHiders()) {
      const dx = h.pos.x - seeker.pos.x;
      const dy = h.pos.y - seeker.pos.y;
      if (dx * dx + dy * dy > CATCH_DISTANCE * CATCH_DISTANCE) continue;
      if (!lineOfSight(this.maze, seeker.pos.x, seeker.pos.y, h.pos.x, h.pos.y)) continue;
      this.capture(h, seeker);
      if (this.phase !== 'hunt') return;
    }
  }

  private capture(h: Player, seeker: Player): void {
    const maze = this.maze!;
    h.caught = true;
    this.caughtOrder.push(h.id);
    for (const p of this.players.values()) {
      if (!p.sink) continue;
      // Only reveal where it happened to players who could see that spot.
      const viewer = p === seeker || p === h || p.caught ? seeker : p;
      const witnessed = p.inRound && (viewer === seeker || canSee(maze, viewer.pos, h.pos, SEND_RANGE));
      p.sink.send(
        witnessed
          ? { t: 'caught', id: h.id, by: seeker.id, x: round2(h.pos.x), y: round2(h.pos.y) }
          : { t: 'caught', id: h.id, by: seeker.id },
      );
    }
    if (this.aliveHiders().length === 0) this.endRound('seeker', 'all-caught', this.clock());
  }

  /** A coarse direction (one of 16) toward the nearest surviving hider. Never a position. */
  private sendHint(): void {
    const seeker = this.players.get(this.seekerId);
    if (!seeker) return;
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const h of this.aliveHiders()) {
      const d = Math.hypot(h.pos.x - seeker.pos.x, h.pos.y - seeker.pos.y);
      if (d < bestDist) {
        bestDist = d;
        best = h;
      }
    }
    if (!best) return;
    const step = Math.PI / 8;
    const angle = Math.round(Math.atan2(best.pos.y - seeker.pos.y, best.pos.x - seeker.pos.x) / step) * step;
    seeker.hint = { angle, at: this.clock() };
    seeker.sink?.send({ t: 'hint', a: angle });
  }

  // ---------------------------------------------------------------------------------------
  // Movement

  private canMove(p: Player): boolean {
    if (!p.inRound || p.caught) return false;
    if (this.phase === 'hunt') return true;
    return (this.phase === 'reveal' || this.phase === 'fade') && p.role === 'hider';
  }

  private onInput(p: Player, round: number, seq: number, dx: number, dy: number): void {
    if (seq <= p.seq) return;
    p.seq = seq;
    if (round !== this.round || !this.maze || !this.canMove(p)) return;

    // Token bucket: a client can never move faster than MAX_SPEED on average, however many
    // inputs it sends, and can bank at most BUDGET_SECONDS of movement.
    const now = this.clock();
    const cap = MAX_SPEED * BUDGET_SECONDS;
    p.budget = Math.min(cap, p.budget + ((now - p.budgetAt) / 1000) * MAX_SPEED * SPEED_TOLERANCE);
    p.budgetAt = now;
    const step = clampStep(dx, dy, MAX_STEP);
    const len = Math.hypot(step.x, step.y);
    if (len > p.budget) {
      const k = p.budget / len;
      step.x *= k;
      step.y *= k;
    }
    p.budget -= Math.min(len, p.budget);
    moveCircle(this.maze, p.pos, step.x, step.y);
    this.checkCaptures();
  }

  private fixedTick(): void {
    if (this.phase !== 'hunt') return;
    if (this.lastTick >= this.nextHintAt) {
      this.nextHintAt += this.timings.hintEveryMs;
      this.sendHint();
    }
    this.checkCaptures();
  }

  // ---------------------------------------------------------------------------------------
  // Messaging

  private createPlayer(id: string, name: string, sink: Sink | null): Player {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const p: Player = {
      id,
      name,
      color,
      sink,
      isBot: sink === null,
      order: this.nextOrder++,
      inRound: false,
      role: 'hider',
      caught: false,
      pos: { x: 0, y: 0 },
      seq: 0,
      budget: 0,
      budgetAt: 0,
      hint: null,
    };
    this.players.set(id, p);
    return p;
  }

  private broadcastRoom(): void {
    const players: PlayerInfo[] = [...this.players.values()]
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.isBot, waiting: this.phase !== 'lobby' && !p.inRound }));
    for (const p of this.players.values()) {
      p.sink?.send({ t: 'room', code: this.code, hostId: this.hostId, status: this.status, players });
    }
  }

  private sendSnapshots(now: number): void {
    const maze = this.maze;
    if (!maze) return;
    const participants = [...this.players.values()].filter((p) => p.inRound);
    const hiders = participants.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught).length;
    const seeker = this.players.get(this.seekerId);
    const entity = (q: Player): EntityState => ({ i: q.id, x: round2(q.pos.x), y: round2(q.pos.y) });

    for (const p of this.players.values()) {
      if (!p.sink) continue;
      const o: EntityState[] = [];
      const msg: ServerMsg = { t: 'snap', st: now, ph: this.phase, pe: this.phaseEnd, alive, total: hiders.length, o };
      if (p.inRound) {
        if (!p.caught) msg.you = { x: p.pos.x, y: p.pos.y, s: p.seq };
        if (this.phase === 'ended') {
          for (const q of participants) if (q !== p && !q.caught) o.push(entity(q));
        } else {
          // Caught players watch the seeker; everyone else sees only what their own light reveals.
          const viewer = p.caught ? seeker : p;
          if (viewer && viewer !== p) {
            msg.view = viewer.id;
            o.push(entity(viewer));
          }
          if (viewer) {
            for (const q of participants) {
              if (q === p || q === viewer || q.caught) continue;
              if (canSee(maze, viewer.pos, q.pos, SEND_RANGE)) o.push(entity(q));
            }
          }
        }
      }
      p.sink.send(msg);
    }
  }
}
