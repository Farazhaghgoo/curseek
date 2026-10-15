// Mouse (pointer lock preferred) and keyboard input. Produces raw deltas; the game loop turns
// them into per-tick movement requests capped at the maximum speed.

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

export class Input {
  /** True while the game wants movement input (playing and able to move). */
  active = false;
  locked = false;
  /** Pointer lock is unavailable here: the mouse moves the player while over the canvas. */
  fallback: boolean;
  onLockChange: () => void = () => {};

  private mx = 0;
  private my = 0;
  private everLocked = false;
  private readonly keys = new Set<string>();

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
