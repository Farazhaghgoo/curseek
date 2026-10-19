// App controller: wires the UI, transport, session, input and renderer together and runs
// the frame loop (fixed 60 Hz input ticks, rendering every animation frame).

import {
  DEFAULT_TIMINGS,
  FINAL_STRETCH_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SEEKER_COLOR,
  TICK_MS,
  VIEW_RADIUS,
} from '../shared/constants';
import { Maze } from '../shared/maze';
import { EFFECT_KINDS, EFFECTS, lightRadius } from '../shared/perks';
import { normaliseRoomCode, type PlayerInfo } from '../shared/protocol';
import { mulberry32, randomSeed } from '../shared/rng';
import { Sound } from './audio';
import { Input } from './input';
import { rejoin } from './rejoin';
import { Renderer, type DrawPlayer, type Frame, type Ripple } from './render';
import { Session, type EndInfo, type SessionListener } from './session';
import { openLocalGame, openSocket, type Transport } from './transport';
import { Ui, type EffectChip, type ResultLine } from './ui';

const NAME_KEY = 'curseek.name';
/** Resume tokens live in session storage, so a reload gets this tab back into its room. */
const tokenKey = (code: string) => `curseek.resume.${code}`;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const ui = new Ui();
const sound = new Sound();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ambientMaze = Maze.generate(mulberry32(randomSeed()));

let session: Session | null = null;
let ripples: (Ripple & { start: number })[] = [];
let hint: { angle: number; start: number } | null = null;
let releaseShownUntil = 0;
let lastCountdown = 0;
let finalStretchShown = false;
/** The light radius as drawn, easing toward the real one when a flare or blindness starts or ends. */
let shownLight = VIEW_RADIUS;
let wasCaptured = false;
let wasExposed = false;
/** Whether this round has already explained what touching a wall does. */
let exposureExplained = false;
/** Set while trying to take back our place after the connection dropped. */
let reconnecting = false;
/** Bumped whenever the player leaves, so a rejoin still in flight knows to give up. */
let generation = 0;
/** The player list as last announced, to tell who dropped out, came back or left. */
let knownPlayers: PlayerInfo[] | null = null;

renderer.setMaze(ambientMaze);
ui.showLanding();
ui.setSound(sound.enabled);
ui.nameInput.value = storageGet(NAME_KEY) ?? '';
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) ui.codeInput.value = normaliseRoomCode(roomParam);
(roomParam && ui.nameInput.value ? ui.codeInput : ui.nameInput).focus();

// After a reload mid-game, take back our place in the room if the server still holds it.
const savedToken = roomParam ? storageGet(tokenKey(ui.codeInput.value), 'sessionStorage') : null;
if (savedToken) {
  ui.setBusy(true);
  void rejoinRoom(ui.codeInput.value, savedToken, () => ui.showLanding());
}

// ---------------------------------------------------------------------------------------
// Landing and lobby actions

function rememberName(name: string): string {
  if (name) storageSet(NAME_KEY, name);
  return name || 'Player';
}

ui.onSolo = (name) => {
  sound.unlock();
  begin(openLocalGame(rememberName(name)));
};

ui.onCreate = (name) => connect((t) => t.send({ t: 'create', name: rememberName(name) }));

ui.onJoin = (name, code) => connect((t) => t.send({ t: 'join', name: rememberName(name), code: normaliseRoomCode(code) }));

ui.onStart = () => {
  sound.unlock();
  session?.send({ t: 'start' });
};
ui.onAddBot = () => session?.send({ t: 'addBot' });
ui.onRemoveBot = () => session?.send({ t: 'removeBot' });
ui.onKick = (id) => session?.send({ t: 'kick', id });
ui.onSettings = (settings) => session?.send({ t: 'settings', ...settings });
ui.onLeave = () => leave();
ui.onToggleSound = () => ui.setSound(sound.toggle());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyM') ui.setSound(sound.toggle());
  // Tab hands the mouse to the game, and back. (Esc ends pointer lock by itself.)
  if (e.code === 'Tab' && (input.captured || canSteer())) {
    e.preventDefault();
    if (!e.repeat) {
      sound.unlock();
      input.toggle();
    }
  }
  if (e.code === 'Escape') input.release();
});

/** Whether the local player is in a round with a cursor of their own to steer. */
function canSteer(): boolean {
  return !reconnecting && session?.status === 'playing' && session.participating && !session.caught;
}

async function connect(first: (t: Transport) => void): Promise<void> {
  sound.unlock();
  ui.setBusy(true);
  ui.showError('');
  try {
    const transport = await openSocket();
    begin(transport);
    first(transport);
  } catch (err) {
    ui.showLanding(err instanceof Error ? err.message : String(err));
  }
}

function begin(transport: Transport): void {
  session?.leave();
  session = new Session(transport, listener);
  knownPlayers = null;
}

function leave(message = ''): void {
  generation++;
  reconnecting = false;
  if (session?.token) storageSet(tokenKey(session.code), null, 'sessionStorage');
  session?.leave();
  session = null;
  input.release();
  ui.setInGame(false);
  renderer.setMaze(ambientMaze);
  history.replaceState(null, '', location.pathname);
  ui.showLanding(message);
}

// ---------------------------------------------------------------------------------------
// Reconnecting

/**
 * Takes back this tab's place in a room after a reload or a dropped connection, retrying while
 * the server cannot be reached. If the place is gone, forget the token and call `failed`.
 */
async function rejoinRoom(code: string, token: string, failed: () => void): Promise<void> {
  const gen = generation;
  reconnecting = true;
  const result = await rejoin({
    code,
    token,
    open: openSocket,
    adopt: (transport, welcome) => {
      begin(transport);
      transport.onMessage(welcome); // The new session's handler by now.
    },
    wanted: () => gen === generation,
    giveUpMs: DEFAULT_TIMINGS.reconnectGraceMs,
  });
  if (result === 'cancelled') return;
  reconnecting = false;
  if (result !== 'ok') {
    storageSet(tokenKey(code), null, 'sessionStorage');
    failed();
  }
}

// ---------------------------------------------------------------------------------------
// Server events

const listener: SessionListener = {
  welcome() {
    const s = session!;
    ui.hideLanding();
    if (s.solo) return;
    history.replaceState(null, '', `${location.pathname}?room=${s.code}`);
    if (s.token) storageSet(tokenKey(s.code), s.token, 'sessionStorage');
  },
  room() {
    const s = session!;
    announcePlayerChanges(s);
    if (s.status === 'lobby') {
      input.release();
      ui.setInGame(false);
      ui.hideResult();
      ui.setHud(null);
      ui.setBanner('');
      renderer.setMaze(ambientMaze);
      const bots = s.players.filter((p) => p.bot).length;
      ui.showLobby({
        code: s.code,
        link: `${location.origin}${location.pathname}?room=${s.code}`,
        players: s.players,
        hostId: s.hostId,
        myId: s.myId,
        isHost: s.isHost,
        canStart: s.players.length >= MIN_PLAYERS,
        canAddBot: s.players.length < MAX_PLAYERS,
        canRemoveBot: bots > 0,
        settings: s.settings,
      });
    } else {
      ui.hideLobby();
      ui.setInGame(true);
    }
  },
  round() {
    const s = session!;
    renderer.setMaze(s.maze);
    ui.hideResult();
    ripples = [];
    hint = null;
    lastCountdown = 0;
    finalStretchShown = false;
    shownLight = VIEW_RADIUS;
    wasExposed = false;
    exposureExplained = false;
    if (s.participating && !s.caught) {
      sound.play('round');
      ui.toast(s.isSeeker ? 'You are the seeker' : 'You are hiding');
    }
  },
  pickup(msg) {
    if (msg.by !== session!.myId) return;
    if (!msg.fx) {
      ui.toast('+1 point');
      sound.play('coin');
      return;
    }
    const fx = EFFECTS[msg.fx];
    const text = `${fx.name}: ${fx.blurb} for ${fx.ms / 1000} s`;
    ui.toast(fx.curse ? `Cursed! ${text}` : text);
    sound.play(fx.curse ? 'curse' : 'perk');
  },
  caught(msg) {
    const s = session!;
    const name = s.playerInfo(msg.id)?.name ?? 'Someone';
    if (msg.id === s.myId) {
      ui.toast(`Caught by ${s.playerInfo(msg.by)?.name ?? 'the seeker'}`);
      sound.play('caught');
    } else if (s.isSeeker) {
      ui.toast(`You caught ${name}`);
      sound.play('catch');
    } else {
      ui.toast(`${name} was caught`);
      sound.play('otherCaught');
    }
    if (msg.x !== undefined && msg.y !== undefined) {
      ripples.push({ x: msg.x, y: msg.y, color: s.playerInfo(msg.id)?.color ?? '#fff', age: 0, start: performance.now() });
    }
  },
  hint(angle) {
    hint = { angle, start: performance.now() };
    sound.play('hint');
  },
  end(info) {
    showResult(info);
    const s = session!;
    if (s.participating && info.winner) {
      const won = (info.winner === 'seeker') === (info.seekerId === s.myId);
      sound.play(won ? 'win' : 'lose');
    }
  },
  error(msg) {
    leave(msg);
  },
  closed(reason) {
    const s = session!;
    if (!s.token) {
      leave(reason);
      return;
    }
    input.release();
    void rejoinRoom(s.code, s.token, () => leave(reason));
  },
};

function announcePlayerChanges(s: Session): void {
  const before = knownPlayers;
  knownPlayers = s.players;
  if (!before) return;
  for (const p of before) {
    if (p.id === s.myId || p.bot) continue;
    const now = s.playerInfo(p.id);
    if (!now) ui.toast(`${p.name} left`);
    else if (now.away && !p.away) ui.toast(`${p.name} lost connection`);
    else if (!now.away && p.away) ui.toast(`${p.name} is back`);
  }
}

function showResult(info: EndInfo): void {
  const s = session!;
  const name = (id: string) => s.playerInfo(id)?.name ?? '?';
  const lines: ResultLine[] = [];
  let title = 'Round over';
  if (info.reason === 'seeker-left') title = 'The seeker left';
  else if (info.reason === 'not-enough-players') title = 'Not enough players';
  else if (info.winner === 'seeker') title = 'Seeker wins';
  else if (info.winner === 'hiders') title = 'Hiders win';

  if (s.participating && info.winner) {
    const me = s.myId;
    if (me === info.seekerId) {
      lines.push({ text: `You caught ${info.caught.length} of ${info.caught.length + info.survivors.length}`, emphasis: true });
    } else if (info.survivors.includes(me)) {
      lines.push({ text: 'You survived', emphasis: true });
    } else if (info.caught.includes(me)) {
      lines.push({ text: 'You were caught', emphasis: true });
    }
  }
  if (info.survivors.length > 0 && info.winner) lines.push({ text: `Survived: ${info.survivors.map(name).join(', ')}` });
  if (info.caught.length > 0) lines.push({ text: `Caught: ${info.caught.map(name).join(', ')}` });
  const board = [...s.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ name: p.name, color: p.color, score: p.score, you: p.id === s.myId }));
  ui.showResult(title, info.winner === 'seeker', lines, nextRoundText(info.next), board);
}

function nextRoundText(next: number | null): string {
  if (next === null || !session) return 'Back to the lobby…';
  const secs = Math.max(0, Math.ceil((next - session.serverNow()) / 1000));
  return `Next round in ${secs}`;
}

// ---------------------------------------------------------------------------------------
// Mouse capture (Tab or a click on the maze; Tab or Esc lets go)

canvas.addEventListener('click', () => {
  sound.unlock();
  if (input.usesTouch) return; // Touch steers with the on-screen joystick instead.
  if (canSteer()) input.capture();
});

// ---------------------------------------------------------------------------------------
// Frame loop

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  const s = session;
  const inRound = !reconnecting && !!s && s.status === 'playing' && !!s.maze && s.participating;
  input.active = inRound && s!.canMoveNow() && (input.captured || hasDirection());

  if (s && inRound) {
    acc += dt;
    let n = Math.floor(acc / TICK_MS);
    acc -= n * TICK_MS;
    if (n > 4) {
      n = 4;
      acc = 0;
    }
    if (n > 0) {
      const mouse = input.active ? input.takeMouse() : { x: 0, y: 0 };
      const dir = input.direction();
      const step = s.maxStep();
      // Spread this frame's mouse motion over its ticks, converted from screen pixels to world units.
      const mx = mouse.x / n / renderer.scale;
      const my = mouse.y / n / renderer.scale;
      // Following the pointer: head for the spot under it, as fast as allowed (keys take over while held).
      const target = input.active && input.following && input.pointer && !hasDirection() ? renderer.toWorld(input.pointer) : null;
      for (let i = 0; i < n; i++) {
        const fx = target ? target.x - s.pos.x : 0;
        const fy = target ? target.y - s.pos.y : 0;
        s.tick({ x: mx + dir.x * step + fx, y: my + dir.y * step + fy });
      }
    }
    if (!input.active) input.clearMouse();
  } else {
    acc = 0;
    input.clearMouse();
  }

  renderer.draw(buildFrame(s, now, dt, acc / TICK_MS));
  updateOverlays(s, now);
  requestAnimationFrame(frame);
}

function hasDirection(): boolean {
  const d = input.direction();
  return d.x !== 0 || d.y !== 0;
}

function buildFrame(s: Session | null, now: number, dt: number, alpha: number): Frame {
  const reduced = reducedMotion.matches;
  const frame: Frame = {
    time: now,
    mazeAlpha: 0.14,
    light: null,
    lightRadius: VIEW_RADIUS,
    items: [],
    itemsAlpha: 0,
    marks: [],
    others: [],
    self: null,
    showAll: false,
    hint: null,
    ripples: [],
    reducedMotion: reduced,
  };
  if (!s || s.status !== 'playing' || !s.maze) return frame;

  const phase = s.phaseAt();
  const serverNow = s.serverNow();
  const t = serverNow - s.roundStart;
  if (phase === 'reveal') frame.mazeAlpha = 1;
  else if (phase === 'fade') {
    const k = Math.min(1, Math.max(0, (t - s.timings.reveal) / s.timings.fade));
    frame.mazeAlpha = 1 - (reduced ? k : k * k * (3 - 2 * k));
  } else if (phase === 'ended') frame.mazeAlpha = 0.55;
  else frame.mazeAlpha = 0;
  frame.showAll = phase === 'ended';

  // Pickups show wherever the maze does, and otherwise only in the light.
  for (const it of s.items.values()) frame.items.push({ x: it.x, y: it.y, kind: it.k });
  frame.itemsAlpha = phase === 'hunt' ? 0 : frame.mazeAlpha;
  if (phase === 'hunt') {
    for (const m of s.marks) {
      frame.marks.push({ x: m.x, y: m.y, color: m.i === s.seekerId ? SEEKER_COLOR : (s.playerInfo(m.i)?.color ?? '#fff') });
    }
  }
  const light = lightRadius(s.effects, serverNow);
  shownLight = reduced ? light : shownLight + (light - shownLight) * (1 - Math.exp(-dt / 140));
  frame.lightRadius = shownLight;

  const draw = (id: string, x: number, y: number): DrawPlayer => {
    const info = s.playerInfo(id);
    return { id, x, y, color: info?.color ?? '#fff', name: info?.name ?? '', seeker: id === s.seekerId, away: info?.away };
  };
  const remotes = s.remotePositions();
  for (const [id, p] of remotes) if (id !== s.spectating || phase === 'ended') frame.others.push(draw(id, p.x, p.y));

  if (s.participating && !s.caught) {
    const p = s.renderPos(alpha, dt);
    frame.self = draw(s.myId, p.x, p.y);
    frame.self.name = '';
    frame.self.ghost = s.hasEffect('cloak', serverNow);
    frame.self.phasing = s.hasEffect('phase', serverNow);
    frame.self.exposed = s.hasEffect('exposed', serverNow);
    frame.light = p;
  } else if (s.spectating) {
    const watched = remotes.get(s.spectating);
    if (watched) {
      frame.light = watched;
      frame.self = draw(s.spectating, watched.x, watched.y);
    }
  }

  if (hint && s.isSeeker && !s.caught) {
    frame.hint = { angle: hint.angle, age: now - hint.start };
  }
  ripples = ripples.filter((r) => now - r.start < 1000);
  frame.ripples = ripples.map((r) => ({ ...r, age: now - r.start }));
  return frame;
}

/** Plays a soft tick once per second for the last `from` seconds of a countdown. */
function countdown(secs: number, from: number): void {
  if (secs !== lastCountdown) {
    lastCountdown = secs;
    if (secs > 0 && secs <= from) sound.play('tick');
  }
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateOverlays(s: Session | null, now: number): void {
  if (s && reconnecting) {
    ui.setBanner('Connection lost — reconnecting…');
    ui.setPrompt(null);
    ui.setEffects([]);
    return;
  }
  if (!s || s.status !== 'playing') {
    if (s) ui.setPrompt(null);
    ui.setEffects([]);
    return;
  }
  const phase = s.phaseAt();
  const serverNow = s.serverNow();
  const toRelease = s.releaseAt - serverNow;
  const huntLeft = s.huntLeft(serverNow);

  let role = 'Watching';
  if (s.participating) role = s.caught ? 'Caught' : s.isSeeker ? 'Seeker' : 'Hider';
  ui.setHud({
    role,
    seeker: s.participating && s.isSeeker,
    time: formatTime(huntLeft),
    lowTime: phase === 'hunt' && huntLeft < 10_000,
    hiders: `${s.alive}/${s.total} hiding`,
  });

  let banner = '';
  if (phase === 'ended') {
    if (s.lastEnd) ui.setResultFooter(nextRoundText(s.lastEnd.next));
  } else if (phase === 'hunt' && s.playerInfo(s.seekerId)?.away) {
    banner = 'The seeker lost connection — the clock is paused';
  } else if (!s.participating) {
    banner = "Watching the seeker — you'll play from the next round";
  } else if (phase === 'reveal' || phase === 'fade') {
    const secs = Math.max(1, Math.ceil(toRelease / 1000));
    countdown(secs, 3);
    banner = s.isSeeker
      ? `Memorize the maze — you're released in ${secs}`
      : phase === 'reveal'
        ? `Memorize the maze and hide — seeker released in ${secs}`
        : `Lights out — seeker released in ${secs}`;
    releaseShownUntil = 0;
  } else if (phase === 'hunt') {
    if (releaseShownUntil === 0) {
      // Resuming mid-hunt: don't replay a release that happened a while ago.
      const late = serverNow - s.releaseAt;
      releaseShownUntil = now + Math.max(1, 1800 - late);
      if (late < 1000) sound.play('release');
    }
    countdown(Math.ceil(huntLeft / 1000), 5);
    if (!finalStretchShown && huntLeft <= FINAL_STRETCH_MS) {
      finalStretchShown = true;
      ui.toast(s.isSeeker ? 'Final stretch: hints every few seconds' : 'Final stretch: the seeker gets more hints');
    }
    if (now < releaseShownUntil) banner = s.isSeeker ? 'Go! Find them.' : 'The seeker is loose';
    else if (s.caught) banner = 'Caught — watching the seeker';
  }
  ui.setBanner(banner);

  const steering = s.participating && !s.caught && phase !== 'ended';
  const chips: EffectChip[] = [];
  if (steering) {
    for (const kind of EFFECT_KINDS) {
      const end = s.effects[kind];
      if (end === undefined || end <= serverNow) continue;
      const fx = EFFECTS[kind];
      chips.push({ kind, name: fx.name, curse: fx.curse, left: end - serverNow, frac: Math.min(1, (end - serverNow) / fx.ms) });
    }
  }
  ui.setEffects(chips);

  // A bump each time a wall gives us away, and the first time in a round, why.
  const exposed = steering && s.hasEffect('exposed', serverNow);
  if (exposed && !wasExposed) {
    sound.play('bump');
    if (!exposureExplained) {
      exposureExplained = true;
      ui.toast('You touched a wall: the seeker can see you');
    }
  }
  wasExposed = exposed;

  let prompt: string | null = null;
  if (steering && input.usesTouch && !input.touching) {
    const portrait = window.innerHeight > window.innerWidth;
    prompt = `Drag anywhere to move${portrait ? ' · turn sideways for a bigger maze' : ''}`;
  } else if (steering && !input.usesTouch && !input.captured) {
    prompt = 'Tab: steer with the mouse · or WASD';
  }
  ui.setPrompt(prompt);
}

// Read-only handle for inspecting the client from the devtools console.
Object.defineProperty(window, 'curseek', { value: { get session() { return session; } } });

window.addEventListener('resize', () => renderer.resize());
input.onLockChange = () => {
  document.body.classList.toggle('following', input.following);
  if (input.captured && !wasCaptured) ui.toast('The mouse steers you · Tab to let go');
  wasCaptured = input.captured;
  updateOverlays(session, performance.now());
};
input.onStickChange = (stick) => ui.setStick(session?.status === 'playing' && session.participating ? stick : null);
requestAnimationFrame(frame);

type StorageArea = 'localStorage' | 'sessionStorage';

function storageGet(key: string, area: StorageArea = 'localStorage'): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

/** Stores a value, or removes it when `value` is null. */
function storageSet(key: string, value: string | null, area: StorageArea = 'localStorage'): void {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode); the name just won't be remembered, and a
    // reload can't rejoin the room (a dropped connection still can).
  }
}
