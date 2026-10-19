import type { ServerMsg } from '../src/shared/protocol';
import { GameRoom, type RoomOptions } from '../src/sim/room';

export type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** A fake client: records everything the room sends it. */
export class Inbox {
  readonly messages: ServerMsg[] = [];
  /** Set once the room closes this connection (the player resumed on another one). */
  closed = false;
  readonly send = (msg: ServerMsg) => {
    this.messages.push(structuredClone(msg));
  };
  readonly close = () => {
    this.closed = true;
  };

  all<T extends ServerMsg['t']>(t: T): Msg<T>[] {
    return this.messages.filter((m): m is Msg<T> => m.t === t);
  }

  last<T extends ServerMsg['t']>(t: T): Msg<T> | undefined {
    return this.all(t).at(-1);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** Resume tokens unique across every room in a test run. */
let tokens = 0;

/**
 * A room driven by a manual clock. Pickups are off unless asked for, so that tests of the core
 * rules never depend on who happens to walk over an orb or a coin.
 */
export class Harness {
  now = 1000;
  readonly room: GameRoom;
  readonly inboxes = new Map<string, Inbox>();

  constructor(opts: Partial<RoomOptions> = {}) {
    this.room = new GameRoom({
      code: 'TEST',
      seed: 1,
      clock: () => this.now,
      newToken: () => `token${++tokens}`,
      pickups: false,
      ...opts,
    });
  }

  join(name: string): { id: string; inbox: Inbox } {
    const inbox = new Inbox();
    const id = this.room.addHuman(name, inbox);
    if (!id) throw new Error('room full');
    this.inboxes.set(id, inbox);
    return { id, inbox };
  }

  /** Advances time in small steps, calling update() as a host would. */
  advance(ms: number, step = 5): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now = Math.min(end, this.now + step);
      this.room.update();
    }
  }

  /** Skips the opening reveal and fade so the seeker is released. */
  toHunt(): void {
    const t = this.room.timings;
    this.advance(t.revealMs + t.fadeMs + 10);
  }
}
