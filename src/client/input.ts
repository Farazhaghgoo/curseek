// Mouse (pointer lock preferred), keyboard and touch input. Produces raw deltas and directions;
// the game loop turns them into per-tick movement requests capped at the maximum speed.

import type { Vec } from '../shared/geometry';

const KEY_DIRS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** How far (CSS pixels) a finger must drag from where it went down for full speed. */
export const STICK_RADIUS = 56;
/** Drags shorter than this fraction of the radius do not move. */
const DEAD_ZONE = 0.15;

/** A virtual joystick: where the finger went down, and its offset scaled to -1..1. */
export interface Stick {
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export class Input {
  /** True while the game wants movement input (playing and able to move). */
  active = false;
  locked = false;
  /** Pointer lock is unavailable here: the mouse moves the player while over the canvas. */
  fallback: boolean;
  onLockChange: () => void = () => {};
  /** Called whenever the touch joystick appears, moves or goes away. */
  onStickChange: (stick: Stick | null) => void = () => {};
  /** This device has been used with touch (or reports a coarse pointer). */
  usesTouch = window.matchMedia('(pointer: coarse)').matches;

  private mx = 0;
  private my = 0;
  private everLocked = false;
  private readonly keys = new Set<string>();
  private stick: (Stick & { id: number }) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.fallback = typeof canvas.requestPointerLock !== 'function';

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.everLocked = true;
      this.mx = 0;
      this.my = 0;
      this.onLockChange();
    });
    document.addEventListener('pointerlockerror', () => this.onLockFailed());

    window.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (this.locked || (this.fallback && e.target === canvas)) {
        this.mx += e.movementX || 0;
        this.my += e.movementY || 0;
      }
    });

    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      if (e.code in KEY_DIRS) {
        this.keys.add(e.code);
        if (this.active) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // Touch: drag anywhere on the maze. The joystick is centred where the finger went down.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        this.usesTouch = false; // A touch laptop's mouse still captures the pointer.
        return;
      }
      if (this.stick) return;
      this.usesTouch = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety: moves over the canvas still arrive without it.
      }
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
      this.emitStick();
    });
    canvas.addEventListener('pointermove', (e) => {
      const stick = this.stick;
      if (!stick || e.pointerId !== stick.id) return;
      const dx = e.clientX - stick.ox;
      const dy = e.clientY - stick.oy;
      const k = 1 / Math.max(STICK_RADIUS, Math.hypot(dx, dy));
      stick.x = dx * k;
      stick.y = dy * k;
      this.emitStick();
    });
    const lift = (e: PointerEvent) => {
      if (this.stick?.id !== e.pointerId) return;
      this.stick = null;
      this.emitStick();
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
  }

  /** Asks for pointer lock. Must be called from a user gesture (a click). */
  requestLock(): void {
    if (this.fallback || this.locked) return;
    try {
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => this.onLockFailed());
    } catch {
      this.onLockFailed();
    }
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Mouse movement (CSS pixels) since the last call. */
  takeMouse(): Vec {
    const d = { x: this.mx, y: this.my };
    this.mx = 0;
    this.my = 0;
    return d;
  }

  /** Discards queued mouse movement, e.g. while the player cannot move. */
  clearMouse(): void {
    this.mx = 0;
    this.my = 0;
  }

  /** True while a finger is on the touch joystick. */
  get touching(): boolean {
    return this.stick !== null;
  }

  /**
   * Keyboard or touch-joystick direction, at most length 1: keys always move at full speed, the
   * joystick in proportion to how far the finger has dragged.
   */
  direction(): Vec {
    const keys = this.keyDirection();
    if (keys.x !== 0 || keys.y !== 0 || !this.stick) return keys;
    const { x, y } = this.stick;
    return Math.hypot(x, y) < DEAD_ZONE ? { x: 0, y: 0 } : { x, y };
  }

  /** Keyboard direction, normalised so diagonals are no faster than straight lines. */
  keyDirection(): Vec {
    let x = 0;
    let y = 0;
    for (const code of this.keys) {
      const d = KEY_DIRS[code];
      if (d) {
        x += d[0];
        y += d[1];
      }
    }
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }

  private emitStick(): void {
    const s = this.stick;
    this.onStickChange(s && { ox: s.ox, oy: s.oy, x: s.x, y: s.y });
  }

  private onLockFailed(): void {
    // Some environments (sandboxed frames, some browsers) refuse pointer lock entirely.
    // If it has never worked, switch to moving with the visible-area mouse instead.
    if (!this.everLocked) this.fallback = true;
    this.onLockChange();
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
