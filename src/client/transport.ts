import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { GameRoom } from '../sim/room';

/** A bidirectional message channel to an authoritative room. */
export interface Transport {
  readonly local: boolean;
  send(msg: ClientMsg): void;
  close(): void;
  onMessage: (msg: ServerMsg) => void;
  onClose: (reason: string) => void;
}

/** Opens a WebSocket to the game server on the page's origin. */
export function openSocket(): Promise<Transport> {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let opened = false;
    const transport: Transport = {
      local: false,
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => {
        transport.onClose = () => {};
        ws.close();
      },
      onMessage: () => {},
      onClose: () => {},
    };
    ws.onopen = () => {
      opened = true;
      resolve(transport);
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string) as ServerMsg;
      } catch {
        return;
      }
      transport.onMessage(msg);
    };
    ws.onclose = () => {
      if (!opened) reject(new Error('Could not reach the game server.'));
      else transport.onClose('Connection to the server was lost.');
    };
  });
}

/**
 * Solo play: runs the same authoritative room in the page, with bots, and talks to it
 * through in-memory messages. The client code cannot tell the difference.
 */
export function openLocalGame(name: string, bots = 3): Transport {
  const room = new GameRoom({ code: 'SOLO', solo: true });
  let id = '';
  let closed = false;
  const transport: Transport = {
    local: true,
    send: (msg) => {
      if (!closed) room.handle(id, msg);
    },
    close: () => {
      closed = true;
      clearInterval(timer);
    },
    onMessage: () => {},
    onClose: () => {},
  };
  id = room.addHuman(name, {
    send: (msg) =>
      queueMicrotask(() => {
        if (!closed) transport.onMessage(msg);
      }),
  })!;
  for (let i = 0; i < bots; i++) room.addBot();
  room.handle(id, { t: 'start' });
  const timer = setInterval(() => room.update(), 8);
  return transport;
}
