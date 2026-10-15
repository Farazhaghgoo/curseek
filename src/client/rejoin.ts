// Taking back a place in a room after a reload or a dropped connection. Kept apart from the page
// so tests can drive it against a real server.

import type { ServerMsg } from '../shared/protocol';
import type { Transport } from './transport';

export type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
export type RejoinResult = 'ok' | 'gone' | 'unreachable' | 'cancelled';

export interface RejoinOptions {
  code: string;
  token: string;
  /** Opens a fresh connection to the server. */
  open: () => Promise<Transport>;
  /** Takes over the connection once the server has handed the place back. */
  adopt: (transport: Transport, welcome: Welcome) => void;
  /** Turns false when the player gives up (leaves); a late success then lets the place go. */
  wanted: () => boolean;
  /** How long to keep retrying a server that cannot be reached. It holds the place about as long. */
  giveUpMs: number;
  retryMs?: number;
}

/**
 * Keeps asking for the place until the server gives it back ('ok'), says it is gone ('gone'),
 * stays out of reach for `giveUpMs` ('unreachable'), or the player gives up ('cancelled').
 */
export async function rejoin(o: RejoinOptions): Promise<RejoinResult> {
  const giveUpAt = performance.now() + o.giveUpMs;
  for (;;) {
    const result = await attempt(o);
    if (!o.wanted()) return 'cancelled';
    if (result !== 'unreachable' || performance.now() >= giveUpAt) return result;
    await new Promise((resolve) => setTimeout(resolve, o.retryMs ?? 1000));
  }
}

async function attempt(o: RejoinOptions): Promise<'ok' | 'gone' | 'unreachable'> {
  const transport = await o.open().catch(() => null);
  if (!transport) return 'unreachable';
  return new Promise((resolve) => {
    transport.onClose = () => resolve('unreachable');
    transport.onMessage = (msg) => {
      if (msg.t === 'error') {
        transport.close();
        resolve('gone');
      } else if (msg.t === 'welcome' && !o.wanted()) {
        // The player left while we were reconnecting: let the place go now.
        transport.send({ t: 'leave' });
        transport.close();
        resolve('ok');
      } else if (msg.t === 'welcome') {
        o.adopt(transport, msg);
        resolve('ok');
      }
    };
    transport.send({ t: 'resume', code: o.code, token: o.token });
  });
}
