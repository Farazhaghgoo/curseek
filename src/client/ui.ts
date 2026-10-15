// DOM overlays: landing screen, lobby, HUD, banner, prompts, toasts and round results.
// Player names are always inserted as text, never as HTML.

import type { PlayerInfo } from '../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface HudState {
  role: string;
  seeker: boolean;
  time: string;
  lowTime: boolean;
  hiders: string;
}

export interface LobbyView {
  code: string;
  link: string;
  players: PlayerInfo[];
  hostId: string | null;
  myId: string;
  isHost: boolean;
  canStart: boolean;
  canAddBot: boolean;
  canRemoveBot: boolean;
}

export interface ResultLine {
  text: string;
  emphasis?: boolean;
}

/** One row of the running scoreboard. */
export interface ScoreLine {
  name: string;
  color: string;
  score: number;
  you: boolean;
}

export class Ui {
  readonly nameInput = $<HTMLInputElement>('name');
  readonly codeInput = $<HTMLInputElement>('code');

  onCreate: (name: string) => void = () => {};
  onJoin: (name: string, code: string) => void = () => {};
  onSolo: (name: string) => void = () => {};
  onStart: () => void = () => {};
  onAddBot: () => void = () => {};
  onRemoveBot: () => void = () => {};
  onKick: (id: string) => void = () => {};
  onLeave: () => void = () => {};
  onToggleSound: () => void = () => {};

  private readonly landing = $('landing');
  private readonly lobby = $('lobby');
  private readonly hud = $('hud');
  private readonly banner = $('banner');
  private readonly prompt = $('prompt');
  private readonly toasts = $('toasts');
  private readonly result = $('result');
  private readonly soundBtn = $<HTMLButtonElement>('btn-sound');
  private readonly leaveBtn = $<HTMLButtonElement>('btn-leave');
  private readonly landingError = $('landing-error');
  private lastHud = '';

  constructor() {
    const name = () => this.nameInput.value.trim();
    $('btn-create').addEventListener('click', () => this.onCreate(name()));
    $('btn-solo').addEventListener('click', () => this.onSolo(name()));
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.codeInput.value.trim();
      if (!code) {
        this.codeInput.focus();
        this.showError('Enter a room code to join.');
        return;
      }
      this.onJoin(name(), code);
    });
    $('btn-start').addEventListener('click', () => this.onStart());
    $('btn-add-bot').addEventListener('click', () => this.onAddBot());
    $('btn-remove-bot').addEventListener('click', () => this.onRemoveBot());
    $('btn-lobby-leave').addEventListener('click', () => this.onLeave());
    this.leaveBtn.addEventListener('click', () => this.onLeave());
    this.soundBtn.addEventListener('click', () => this.onToggleSound());
    $('btn-copy').addEventListener('click', () => this.copyInvite());
  }

  showLanding(error = ''): void {
    this.landing.hidden = false;
    this.lobby.hidden = true;
    this.leaveBtn.hidden = true;
    this.setHud(null);
    this.setBanner('');
    this.setPrompt(null);
    this.hideResult();
    this.showError(error);
    this.setBusy(false);
  }

  hideLanding(): void {
    this.landing.hidden = true;
    this.leaveBtn.hidden = false;
  }

  showError(msg: string): void {
    this.landingError.textContent = msg;
  }

  setBusy(busy: boolean): void {
    for (const id of ['btn-create', 'btn-solo', 'btn-join']) $<HTMLButtonElement>(id).disabled = busy;
  }

  showLobby(v: LobbyView): void {
    this.lobby.hidden = false;
    $('lobby-code').textContent = v.code;
    $<HTMLInputElement>('invite-link').value = v.link;
    const list = $('lobby-players');
    const scored = v.players.some((p) => p.score > 0);
    list.replaceChildren(
      ...v.players.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.color = p.color;
        const name = document.createElement('span');
        name.textContent = p.name + (p.id === v.myId ? ' (you)' : '');
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = p.bot ? 'bot' : p.away ? 'away' : p.id === v.hostId ? 'host' : '';
        li.classList.toggle('away', p.away);
        li.append(dot, name, tag);
        if (scored) li.append(scoreText('score', p.score));
        if (v.isHost && p.id !== v.myId) {
          const kick = document.createElement('button');
          kick.type = 'button';
          kick.className = 'kick';
          kick.textContent = '✕';
          kick.title = `Remove ${p.name}`;
          kick.setAttribute('aria-label', `Remove ${p.name}`);
          kick.addEventListener('click', () => this.onKick(p.id));
          li.append(kick);
        }
        return li;
      }),
    );
    for (const el of this.lobby.querySelectorAll<HTMLElement>('.host-only')) el.hidden = !v.isHost;
    $<HTMLButtonElement>('btn-start').disabled = !v.canStart;
    $<HTMLButtonElement>('btn-add-bot').disabled = !v.canAddBot;
    $<HTMLButtonElement>('btn-remove-bot').disabled = !v.canRemoveBot;
    $('lobby-note').textContent = v.isHost
      ? v.canStart
        ? 'Invite friends with the code or link, or add bots.'
        : 'Waiting for at least one more player (or add a bot).'
      : 'Waiting for the host to start…';
  }

  hideLobby(): void {
    this.lobby.hidden = true;
  }

  setInGame(inGame: boolean): void {
    document.body.classList.toggle('in-game', inGame);
  }

  setHud(state: HudState | null): void {
    if (!state) {
      this.hud.hidden = true;
      this.lastHud = '';
      return;
    }
    const key = JSON.stringify(state);
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.hud.hidden = false;
    const role = $('hud-role');
    role.textContent = state.role;
    role.classList.toggle('seeker', state.seeker);
    const time = $('hud-time');
    time.textContent = state.time;
    time.classList.toggle('low', state.lowTime);
    $('hud-hiders').textContent = state.hiders;
  }

  setBanner(text: string): void {
    if (this.banner.textContent !== text) this.banner.textContent = text;
  }

  setPrompt(text: string | null): void {
    this.prompt.hidden = text === null;
    if (text !== null && this.prompt.textContent !== text) this.prompt.textContent = text;
  }

  toast(text: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  showResult(title: string, seekerWon: boolean, lines: ResultLine[], footer: string, board: ScoreLine[]): void {
    const h = document.createElement('h2');
    h.textContent = title;
    h.classList.toggle('seeker', seekerWon);
    const ps = lines.map((l) => {
      const p = document.createElement('p');
      p.textContent = l.text;
      if (l.emphasis) p.className = 'you';
      return p;
    });
    const ol = document.createElement('ol');
    ol.className = 'board';
    ol.setAttribute('aria-label', 'Scores');
    ol.replaceChildren(
      ...board.map((b) => {
        const li = document.createElement('li');
        li.classList.toggle('you', b.you);
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.color = b.color;
        const name = document.createElement('span');
        name.textContent = b.name;
        li.append(dot, name, scoreText('pts', b.score));
        return li;
      }),
    );
    const foot = document.createElement('p');
    foot.id = 'result-footer';
    foot.textContent = footer;
    this.result.replaceChildren(h, ...ps, ol, foot);
    this.result.hidden = false;
  }

  setResultFooter(text: string): void {
    const foot = document.getElementById('result-footer');
    if (foot && foot.textContent !== text) foot.textContent = text;
  }

  hideResult(): void {
    this.result.hidden = true;
  }

  setSound(on: boolean): void {
    this.soundBtn.setAttribute('aria-pressed', String(on));
    this.soundBtn.title = on ? 'Sound on (M)' : 'Sound off (M)';
  }

  private async copyInvite(): Promise<void> {
    const input = $<HTMLInputElement>('invite-link');
    try {
      await navigator.clipboard.writeText(input.value);
      this.toast('Invite link copied');
    } catch {
      input.select();
      this.toast('Press Ctrl+C to copy the link');
    }
  }
}

function scoreText(className: string, score: number): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = `${score} ${score === 1 ? 'pt' : 'pts'}`;
  return el;
}
