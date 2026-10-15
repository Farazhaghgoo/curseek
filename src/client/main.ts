// App controller: wires the UI, transport, session, input and renderer together and runs
// the frame loop (fixed 60 Hz input ticks, rendering every animation frame).

import { DEFAULT_TIMINGS, FINAL_STRETCH_MS, MAX_PLAYERS, MAX_STEP, MIN_PLAYERS, TICK_MS } from '../shared/constants';
import { Maze } from '../shared/maze';
import { normaliseRoomCode, type PlayerInfo } from '../shared/protocol';
import { mulberry32, randomSeed } from '../shared/rng';
import { Sound } from './audio';
import { Input } from './input';
import { Renderer, type DrawPlayer, type Frame, type Ripple } from './render';
import { Session, type EndInfo, type SessionListener } from './session';
import { openLocalGame, openSocket, type Transport } from './transport';
import { Ui, type ResultLine } from './ui';

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
  void rejoin(ui.codeInput.value, savedToken, () => ui.showLanding());
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
  if (e.code === 'KeyM' && !(e.target instanceof HTMLInputElement)) ui.setSound(sound.toggle());
});

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
  input.releaseLock();
  ui.setInGame(false);
  renderer.setMaze(ambientMaze);
  history.replaceState(null, '', location.pathname);
  ui.showLanding(message);
}

// ---------------------------------------------------------------------------------------
// Reconnecting

/**
 * Takes back this tab's place in a room after a reload or a dropped connection. The server holds
 * the place for a few seconds, so keep trying while it cannot be reached. If the place is gone,
 * forget the token and call `failed`.
 */
async function rejoin(code: string, token: string, failed: () => void): Promise<void> {
  const gen = generation;
  const giveUpAt = performance.now() + DEFAULT_TIMINGS.reconnectGraceMs;
  reconnecting = true;
  for (;;) {
    const result = await tryResume(code, token, gen);
    if (gen !== generation) return; // The player left meanwhile.
    if (result === 'unreachable' && performance.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    reconnecting = false;
    if (result !== 'ok') {
      storageSet(tokenKey(code), null, 'sessionStorage');
      failed();
    }
    return;
  }
}

/** One attempt over a fresh connection. On success a new session takes over at once. */
async function tryResume(code: string, token: string, gen: number): Promise<'ok' | 'gone' | 'unreachable'> {
  const transport = await openSocket().catch(() => null);
  if (!transport) return 'unreachable';
  return new Promise((resolve) => {
    transport.onClose = () => resolve('unreachable');
    transport.onMessage = (msg) => {
      if (msg.t === 'error') {
        transport.close();
        resolve('gone');
      } else if (msg.t === 'welcome' && gen !== generation) {
        // The player left while we were reconnecting: let the place go now.
        transport.send({ t: 'leave' });
        transport.close();
        resolve('ok');
      } else if (msg.t === 'welcome') {
        begin(transport);
        transport.onMessage(msg); // The new session's handler by now.
        resolve('ok');
      }
    };
    transport.send({ t: 'resume', code, token });
  });
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
      input.releaseLock();
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
    if (s.participating && !s.caught) {
      sound.play('round');
      ui.toast(s.isSeeker ? 'You are the seeker' : 'You are hiding');
    }
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
    input.releaseLock();
    void rejoin(s.code, s.token, () => leave(reason));
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
// Pointer lock

canvas.addEventListener('click', () => {
  sound.unlock();
  if (!reconnecting && session?.status === 'playing' && session.participating) input.requestLock();
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
  input.active = inRound && s!.canMoveNow() && (input.locked || input.fallback || hasKeys());

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
      const keys = input.keyDirection();
      // Spread this frame's mouse motion over its ticks, converted from screen pixels to world units.
      const mx = mouse.x / n / renderer.scale;
      const my = mouse.y / n / renderer.scale;
      for (let i = 0; i < n; i++) s.tick({ x: mx + keys.x * MAX_STEP, y: my + keys.y * MAX_STEP });
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

function hasKeys(): boolean {
  const k = input.keyDirection();
  return k.x !== 0 || k.y !== 0;
}

function buildFrame(s: Session | null, now: number, dt: number, alpha: number): Frame {
  const reduced = reducedMotion.matches;
  const frame: Frame = {
    time: now,
    mazeAlpha: 0.14,
    light: null,
    others: [],
    self: null,
    showAll: false,
    hint: null,
    ripples: [],
    reducedMotion: reduced,
  };
  if (!s || s.status !== 'playing' || !s.maze) return frame;

  const phase = s.phaseAt();
  const t = s.serverNow() - s.roundStart;
  if (phase === 'reveal') frame.mazeAlpha = 1;
  else if (phase === 'fade') {
    const k = Math.min(1, Math.max(0, (t - s.timings.reveal) / s.timings.fade));
    frame.mazeAlpha = 1 - (reduced ? k : k * k * (3 - 2 * k));
  } else if (phase === 'ended') frame.mazeAlpha = 0.55;
  else frame.mazeAlpha = 0;
  frame.showAll = phase === 'ended';

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
    return;
  }
  if (!s || s.status !== 'playing') {
    if (s) ui.setPrompt(null);
    return;
  }
  const phase = s.phaseAt();
  const serverNow = s.serverNow();
  const toRelease = s.releaseAt - serverNow;
  const huntLeft = phase === 'hunt' ? s.phaseEnd - serverNow : phase === 'ended' ? 0 : s.timings.hunt;

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
    if (s.playerInfo(s.seekerId)?.away) banner = 'The seeker lost connection — the clock is paused';
    else if (now < releaseShownUntil) banner = s.isSeeker ? 'Go! Find them.' : 'The seeker is loose';
    else if (s.caught) banner = 'Caught — watching the seeker';
  }
  ui.setBanner(banner);

  const needsLock = s.participating && !s.caught && phase !== 'ended' && !input.locked && !input.fallback;
  ui.setPrompt(needsLock ? 'Click the maze to move with your mouse · or use WASD' : null);
}

// Read-only handle for inspecting the client from the devtools console.
Object.defineProperty(window, 'curseek', { value: { get session() { return session; } } });

window.addEventListener('resize', () => renderer.resize());
input.onLockChange = () => updateOverlays(session, performance.now());
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
