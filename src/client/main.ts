// App controller: wires the UI, transport, session, input and renderer together and runs
// the frame loop (fixed 60 Hz input ticks, rendering every animation frame).

import { MAX_PLAYERS, MAX_STEP, MIN_PLAYERS, TICK_MS } from '../shared/constants';
import { Maze } from '../shared/maze';
import { normaliseRoomCode } from '../shared/protocol';
import { mulberry32, randomSeed } from '../shared/rng';
import { Input } from './input';
import { Renderer, type DrawPlayer, type Frame, type Ripple } from './render';
import { Session, type EndInfo, type SessionListener } from './session';
import { openLocalGame, openSocket, type Transport } from './transport';
import { Ui, type ResultLine } from './ui';

const NAME_KEY = 'curseek.name';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const ui = new Ui();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ambientMaze = Maze.generate(mulberry32(randomSeed()));

let session: Session | null = null;
let ripples: (Ripple & { start: number })[] = [];
let hint: { angle: number; start: number } | null = null;
let releaseShownUntil = 0;

renderer.setMaze(ambientMaze);
ui.showLanding();
ui.nameInput.value = storageGet(NAME_KEY) ?? '';
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) ui.codeInput.value = normaliseRoomCode(roomParam);
(roomParam && ui.nameInput.value ? ui.codeInput : ui.nameInput).focus();

// ---------------------------------------------------------------------------------------
// Landing and lobby actions

function rememberName(name: string): string {
  if (name) storageSet(NAME_KEY, name);
  return name || 'Player';
}

ui.onSolo = (name) => begin(openLocalGame(rememberName(name)));

ui.onCreate = (name) => connect((t) => t.send({ t: 'create', name: rememberName(name) }));

ui.onJoin = (name, code) => connect((t) => t.send({ t: 'join', name: rememberName(name), code: normaliseRoomCode(code) }));

ui.onStart = () => session?.send({ t: 'start' });
ui.onAddBot = () => session?.send({ t: 'addBot' });
ui.onRemoveBot = () => session?.send({ t: 'removeBot' });
ui.onLeave = () => leave();

async function connect(first: (t: Transport) => void): Promise<void> {
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
}

function leave(message = ''): void {
  session?.leave();
  session = null;
  input.releaseLock();
  ui.setInGame(false);
  renderer.setMaze(ambientMaze);
  history.replaceState(null, '', location.pathname);
  ui.showLanding(message);
}

// ---------------------------------------------------------------------------------------
// Server events

const listener: SessionListener = {
  welcome() {
    const s = session!;
    ui.hideLanding();
    if (!s.solo) history.replaceState(null, '', `${location.pathname}?room=${s.code}`);
  },
  room() {
    const s = session!;
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
    if (s.participating) {
      ui.toast(s.isSeeker ? 'You are the seeker' : 'You are hiding');
    }
  },
  caught(msg) {
    const s = session!;
    const name = s.playerInfo(msg.id)?.name ?? 'Someone';
    if (msg.id === s.myId) {
      ui.toast(`Caught by ${s.playerInfo(msg.by)?.name ?? 'the seeker'}`);
    } else if (s.isSeeker) {
      ui.toast(`You caught ${name}`);
    } else {
      ui.toast(`${name} was caught`);
    }
    if (msg.x !== undefined && msg.y !== undefined) {
      ripples.push({ x: msg.x, y: msg.y, color: s.playerInfo(msg.id)?.color ?? '#fff', age: 0, start: performance.now() });
    }
  },
  hint(angle) {
    hint = { angle, start: performance.now() };
  },
  end(info) {
    showResult(info);
  },
  error(msg) {
    leave(msg);
  },
  closed(reason) {
    leave(reason);
  },
};

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
  ui.showResult(title, info.winner === 'seeker', lines, nextRoundText(info.next));
}

function nextRoundText(next: number | null): string {
  if (next === null || !session) return 'Back to the lobby…';
  const secs = Math.max(0, Math.ceil((next - session.serverNow()) / 1000));
  return `Next round in ${secs}`;
}

// ---------------------------------------------------------------------------------------
// Pointer lock

canvas.addEventListener('click', () => {
  if (session?.status === 'playing' && session.participating) input.requestLock();
});

// ---------------------------------------------------------------------------------------
// Frame loop

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  const s = session;
  const inRound = !!s && s.status === 'playing' && !!s.maze && s.participating;
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
  if (!s || s.status !== 'playing' || !s.maze || !s.participating) return frame;

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
    return { id, x, y, color: info?.color ?? '#fff', name: info?.name ?? '', seeker: id === s.seekerId };
  };
  const remotes = s.remotePositions();
  for (const [id, p] of remotes) if (id !== s.spectating || phase === 'ended') frame.others.push(draw(id, p.x, p.y));

  if (!s.caught) {
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

function formatTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateOverlays(s: Session | null, now: number): void {
  if (!s || s.status !== 'playing') {
    if (s) ui.setPrompt(null);
    return;
  }
  const phase = s.phaseAt();
  const serverNow = s.serverNow();
  const toRelease = s.releaseAt - serverNow;
  const huntLeft = phase === 'hunt' ? s.phaseEnd - serverNow : phase === 'ended' ? 0 : s.timings.hunt;

  let role = 'Waiting';
  if (s.participating) role = s.caught ? 'Caught' : s.isSeeker ? 'Seeker' : 'Hider';
  ui.setHud({
    role,
    seeker: s.participating && s.isSeeker,
    time: formatTime(huntLeft),
    lowTime: phase === 'hunt' && huntLeft < 10_000,
    hiders: `${s.alive}/${s.total} hiding`,
  });

  let banner = '';
  if (!s.participating) {
    banner = "Round in progress — you'll join the next one";
  } else if (phase === 'reveal' || phase === 'fade') {
    const secs = Math.max(1, Math.ceil(toRelease / 1000));
    banner = s.isSeeker
      ? `Memorize the maze — you're released in ${secs}`
      : phase === 'reveal'
        ? `Memorize the maze and hide — seeker released in ${secs}`
        : `Lights out — seeker released in ${secs}`;
    releaseShownUntil = 0;
  } else if (phase === 'hunt') {
    if (releaseShownUntil === 0) releaseShownUntil = now + 1800;
    if (now < releaseShownUntil) banner = s.isSeeker ? 'Go! Find them.' : 'The seeker is loose';
    else if (s.caught) banner = 'Caught — watching the seeker';
  } else if (phase === 'ended' && s.lastEnd) {
    ui.setResultFooter(nextRoundText(s.lastEnd.next));
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

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode); the name just won't be remembered.
  }
}
