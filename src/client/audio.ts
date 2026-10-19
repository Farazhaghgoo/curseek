// Tiny procedural sound effects (Web Audio oscillators, no asset files).

export type Cue =
  | 'round'
  | 'tick'
  | 'release'
  | 'catch'
  | 'caught'
  | 'otherCaught'
  | 'hint'
  | 'win'
  | 'lose'
  | 'coin'
  | 'perk'
  | 'curse'
  | 'bump';

const STORAGE_KEY = 'curseek.sound';

/** [frequency Hz, start offset s, duration s, waveform] per note. */
const CUES: Record<Cue, { notes: [number, number, number, OscillatorType][]; gain: number }> = {
  round: { notes: [[440, 0, 0.18, 'sine'], [660, 0.12, 0.28, 'sine']], gain: 0.12 },
  tick: { notes: [[880, 0, 0.06, 'square']], gain: 0.025 },
  release: { notes: [[110, 0, 0.7, 'sine'], [165, 0.02, 0.6, 'triangle']], gain: 0.22 },
  catch: { notes: [[660, 0, 0.12, 'triangle'], [990, 0.09, 0.22, 'triangle']], gain: 0.14 },
  caught: { notes: [[440, 0, 0.18, 'sawtooth'], [220, 0.14, 0.4, 'sawtooth']], gain: 0.06 },
  otherCaught: { notes: [[330, 0, 0.25, 'sine']], gain: 0.07 },
  hint: { notes: [[520, 0, 0.5, 'sine'], [780, 0.05, 0.45, 'sine']], gain: 0.05 },
  win: { notes: [[523, 0, 0.2, 'triangle'], [659, 0.12, 0.2, 'triangle'], [784, 0.24, 0.4, 'triangle']], gain: 0.12 },
  lose: { notes: [[392, 0, 0.25, 'triangle'], [311, 0.18, 0.45, 'triangle']], gain: 0.1 },
  coin: { notes: [[988, 0, 0.08, 'square'], [1319, 0.07, 0.2, 'square']], gain: 0.035 },
  perk: { notes: [[523, 0, 0.12, 'triangle'], [784, 0.08, 0.14, 'triangle'], [1047, 0.16, 0.28, 'triangle']], gain: 0.1 },
  curse: { notes: [[300, 0, 0.22, 'sawtooth'], [212, 0.14, 0.4, 'sawtooth']], gain: 0.05 },
  bump: { notes: [[150, 0, 0.12, 'sine'], [95, 0.03, 0.16, 'triangle']], gain: 0.1 },
};

export class Sound {
  enabled: boolean;
  private ctx: AudioContext | null = null;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: default to on.
    }
    this.enabled = stored !== 'off';
  }

  /** Audio can only start after a user gesture; call this from click handlers. */
  unlock(): void {
    if (!this.enabled) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      // Not persisted; fine.
    }
    if (this.enabled) this.unlock();
    return this.enabled;
  }

  play(cue: Cue): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state !== 'running') return;
    const { notes, gain } = CUES[cue];
    const t0 = ctx.currentTime;
    for (const [freq, offset, dur, type] of notes) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const start = t0 + offset;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.03, dur / 3));
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(env).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    }
  }
}
