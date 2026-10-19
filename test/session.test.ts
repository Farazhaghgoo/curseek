// The client session's view of the round clock, fed messages directly (no server).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINAL_STRETCH_MS } from '../src/shared/constants';
import { Maze } from '../src/shared/maze';
import type { RoundTimings, ServerMsg } from '../src/shared/protocol';
import { mulberry32 } from '../src/shared/rng';
import { Session } from '../src/client/session';
import type { Transport } from '../src/client/transport';

const timings: RoundTimings = { reveal: 3000, fade: 2000, hunt: 90000 };
const start = 1000;
const release = start + timings.reveal + timings.fade;

/** A session that has just been sent a round starting at `start`, and a way to send it more. */
function inRound(): { session: Session; receive: (msg: ServerMsg) => void } {
  const transport: Transport = { local: false, send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} };
  const noop = () => {};
  const session = new Session(transport, {
    welcome: noop,
    room: noop,
    round: noop,
    caught: noop,
    hint: noop,
    end: noop,
    error: noop,
    closed: noop,
  });
  const receive = (msg: ServerMsg) => transport.onMessage(msg);
  const maze = Maze.generate(mulberry32(1)).toData();
  receive({ t: 'round', n: 1, maze, seekerId: 'seeker', you: { x: 40, y: 40 }, start, timings });
  return { session, receive };
}

function snap(ph: 'fade' | 'hunt', pe: number): ServerMsg {
  return { t: 'snap', st: pe - 1, ph, pe, alive: 1, total: 1, o: [] };
}

test('the hunt clock starts full even before the first hunt snapshot arrives', () => {
  const { session, receive } = inRound();
  // The last snapshot of the fade says the phase ends at the release.
  receive(snap('fade', release));
  assert.equal(session.huntLeft(release - 10), timings.hunt);

  // Our clock passes the release a moment before the server's hunt snapshot gets here.
  const t = release + 10;
  assert.equal(session.phaseAt(t), 'hunt');
  assert.equal(session.huntLeft(t), timings.hunt - 10);
  assert.ok(session.huntLeft(t) > FINAL_STRETCH_MS, 'not yet the final stretch');
});

test('once the server confirms the hunt, its phase end wins', () => {
  const { session, receive } = inRound();
  // The hunt end the server reports moves later when it pauses the clock for an absent seeker.
  const paused = 4000;
  receive(snap('hunt', release + timings.hunt + paused));
  assert.equal(session.huntLeft(release + 10), timings.hunt + paused - 10);
});
