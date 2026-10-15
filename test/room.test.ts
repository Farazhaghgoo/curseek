import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SPEED, MAX_STEP, VIEW_RADIUS } from '../src/shared/constants';
import type { Maze } from '../src/shared/maze';
import { Harness, Inbox } from './helpers';

function startGame(names = ['Ann', 'Bob']) {
  const h = new Harness();
  const players = names.map((n) => h.join(n));
  h.room.handle(players[0].id, { t: 'start' });
  const seekerId = h.room.currentSeeker;
  const seeker = players.find((p) => p.id === seekerId)!;
  const hiders = players.filter((p) => p.id !== seekerId);
  return { h, players, seeker, hiders };
}

let seq = 1000;
function sendInput(h: Harness, id: string, inbox: Inbox, x: number, y: number): void {
  const round = inbox.last('round')!.n;
  h.room.handle(id, { t: 'input', r: round, s: seq++, x, y });
}

/** A cell with a wall on its right-hand side, as world coordinates of that wall. */
function findRightWall(maze: Maze): { wallX: number; y: number } {
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols - 1; x++) {
      if (maze.v[y * (maze.cols + 1) + x + 1]) return { wallX: (x + 1) * maze.cell, y: (y + 0.5) * maze.cell };
    }
  }
  throw new Error('no interior wall');
}

test('first player hosts; only the host can start and needs two players', () => {
  const h = new Harness();
  const a = h.join('Ann');
  h.room.handle(a.id, { t: 'start' });
  assert.equal(h.room.currentPhase, 'lobby', 'cannot start alone');
  const b = h.join('Bob');
  h.room.handle(b.id, { t: 'start' });
  assert.equal(h.room.currentPhase, 'lobby', 'non-host cannot start');
  h.room.handle(a.id, { t: 'start' });
  assert.equal(h.room.currentPhase, 'reveal');
  assert.equal(a.inbox.last('room')!.hostId, a.id);
});

test('round messages carry only your own spawn', () => {
  const { players } = startGame(['Ann', 'Bob', 'Cat']);
  const spawns = players.map((p) => p.inbox.last('round')!.you);
  assert.equal(new Set(spawns.map((s) => `${s!.x},${s!.y}`)).size, 3);
  for (const p of players) {
    const round = p.inbox.last('round')!;
    assert.deepEqual(Object.keys(round).sort(), ['maze', 'n', 'seekerId', 'start', 't', 'timings', 'you']);
  }
});

test('maze is shown for 3 s, fades for 2 s, then the hunt lasts 90 s', () => {
  const { h } = startGame();
  h.advance(2990);
  assert.equal(h.room.currentPhase, 'reveal');
  h.advance(20);
  assert.equal(h.room.currentPhase, 'fade');
  h.advance(1980);
  assert.equal(h.room.currentPhase, 'fade');
  h.advance(20);
  assert.equal(h.room.currentPhase, 'hunt');
  h.advance(89_980);
  assert.equal(h.room.currentPhase, 'hunt');
  h.advance(30);
  assert.equal(h.room.currentPhase, 'ended');
});

test('the seeker is frozen until the fade ends; hiders may move during the reveal', () => {
  const { h, seeker, hiders } = startGame();
  const s0 = h.room.positionOf(seeker.id)!;
  const h0 = h.room.positionOf(hiders[0].id)!;
  for (let i = 0; i < 100; i++) {
    h.advance(17);
    sendInput(h, seeker.id, seeker.inbox, MAX_STEP, 0);
    sendInput(h, seeker.id, seeker.inbox, 0, MAX_STEP);
    sendInput(h, hiders[0].id, hiders[0].inbox, MAX_STEP, MAX_STEP);
  }
  assert.deepEqual(h.room.positionOf(seeker.id), s0, 'seeker moved during reveal/fade');
  assert.notDeepEqual(h.room.positionOf(hiders[0].id), h0, 'hider should be able to move');

  h.advance(5000);
  assert.equal(h.room.currentPhase, 'hunt');
  for (let i = 0; i < 30; i++) {
    h.advance(17);
    sendInput(h, seeker.id, seeker.inbox, MAX_STEP, MAX_STEP);
    sendInput(h, seeker.id, seeker.inbox, -MAX_STEP, MAX_STEP);
  }
  assert.notDeepEqual(h.room.positionOf(seeker.id), s0, 'seeker should move after release');
});

test('flooding inputs cannot exceed the maximum speed', () => {
  const { h, hiders } = startGame();
  const hider = hiders[0];
  // Walls can only shorten the distance travelled, so this bounds speed anywhere in the maze.
  const p0 = h.room.positionOf(hider.id)!;
  let travelled = 0;
  let prev = p0;
  for (let frame = 0; frame < 60; frame++) {
    h.advance(1000 / 60);
    for (let i = 0; i < 20; i++) sendInput(h, hider.id, hider.inbox, MAX_STEP * 5, (i % 2 ? 1 : -1) * MAX_STEP);
    const p = h.room.positionOf(hider.id)!;
    travelled += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  const allowed = MAX_SPEED * 1.05 * 1 + MAX_SPEED * 0.15 + 1;
  assert.ok(travelled <= allowed, `travelled ${travelled.toFixed(1)} in 1 s (allowed ${allowed.toFixed(1)})`);
});

test('inputs for an old round are ignored', () => {
  const { h, hiders } = startGame();
  const hider = hiders[0];
  const p0 = h.room.positionOf(hider.id)!;
  h.room.handle(hider.id, { t: 'input', r: 999, s: seq++, x: MAX_STEP, y: 0 });
  h.room.handle(hider.id, { t: 'input', r: 999, s: seq++, x: 0, y: MAX_STEP });
  assert.deepEqual(h.room.positionOf(hider.id), p0);
});

test('touching a hider catches them; the last capture wins the round for the seeker', () => {
  const { h, seeker, hiders, players } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const s = h.room.positionOf(seeker.id)!;
  h.room.placePlayer(hiders[0].id, s.x + 5, s.y);
  h.advance(20);
  for (const p of players) {
    const caught = p.inbox.last('caught');
    assert.equal(caught?.id, hiders[0].id);
    assert.equal(caught?.by, seeker.id);
  }
  assert.equal(h.room.currentPhase, 'hunt');
  assert.ok(seeker.inbox.last('caught')!.x !== undefined, 'seeker sees where the capture happened');

  h.room.placePlayer(hiders[1].id, s.x, s.y + 4);
  h.advance(20);
  assert.equal(h.room.currentPhase, 'ended');
  const ends = players.map((p) => p.inbox.last('end')!);
  for (const e of ends) {
    assert.equal(e.winner, 'seeker');
    assert.equal(e.reason, 'all-caught');
    assert.deepEqual(e.caught, [hiders[0].id, hiders[1].id]);
    assert.deepEqual(e.survivors, []);
  }
  assert.deepEqual(ends[0], ends[1], 'all clients get the same result');
});

test('no capture through a wall, even at touching distance', () => {
  const { h, seeker, hiders } = startGame();
  h.toHunt();
  const wall = findRightWall(h.room.currentMaze!);
  h.room.placePlayer(seeker.id, wall.wallX - 6, wall.y);
  h.room.placePlayer(hiders[0].id, wall.wallX + 6, wall.y);
  h.advance(100);
  assert.equal(h.room.currentPhase, 'hunt');
  assert.equal(seeker.inbox.all('caught').length, 0);
});

test('surviving hiders win when time runs out, then the seeker rotates', () => {
  const { h, seeker, players } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  h.advance(90_000);
  const end = players[0].inbox.last('end')!;
  assert.equal(end.winner, 'hiders');
  assert.equal(end.reason, 'time');
  assert.equal(end.survivors.length, 2);
  assert.ok(end.next !== null);

  h.advance(h.room.timings.intermissionMs + 10);
  assert.equal(h.room.currentPhase, 'reveal');
  assert.notEqual(h.room.currentSeeker, seeker.id);
  const seekers = new Set([seeker.id, h.room.currentSeeker]);
  h.toHunt();
  h.advance(90_000 + h.room.timings.intermissionMs + 10);
  seekers.add(h.room.currentSeeker);
  assert.equal(seekers.size, 3, 'every player gets a turn as seeker');
  assert.equal(players[0].inbox.last('round')!.n, 3);
});

test('a new maze is generated every round', () => {
  const { h, players } = startGame();
  const first = players[0].inbox.last('round')!.maze;
  h.toHunt();
  h.advance(90_000 + h.room.timings.intermissionMs + 10);
  const second = players[0].inbox.last('round')!.maze;
  assert.notEqual(first.h + first.v, second.h + second.v);
});

test('snapshots never include opponents behind walls or out of range', () => {
  const { h, seeker, hiders } = startGame();
  h.toHunt();
  const maze = h.room.currentMaze!;
  const wall = findRightWall(maze);
  const lastOthers = () => {
    seeker.inbox.clear();
    h.advance(40);
    return seeker.inbox.last('snap')!.o.map((e) => e.i);
  };

  h.room.placePlayer(seeker.id, wall.wallX - 10, wall.y);
  h.room.placePlayer(hiders[0].id, wall.wallX + 10, wall.y);
  assert.deepEqual(lastOthers(), [], 'hidden behind a wall');

  const far = maze.cellCenter(maze.cellCount - 1);
  const near = maze.cellCenter(0);
  h.room.placePlayer(seeker.id, near.x, near.y);
  h.room.placePlayer(hiders[0].id, far.x, far.y);
  assert.ok(Math.hypot(far.x - near.x, far.y - near.y) > VIEW_RADIUS * 2);
  assert.deepEqual(lastOthers(), [], 'out of range');

  // Next cell along an open edge: clear line of sight, beyond touching distance.
  const next = maze.cellCenter(maze.neighbours(0)[0]);
  h.room.placePlayer(hiders[0].id, next.x, next.y);
  assert.deepEqual(lastOthers(), [hiders[0].id], 'in plain sight in the next cell');
});

test('the seeker gets a coarse direction hint every 12 seconds', () => {
  const { h, seeker, hiders } = startGame();
  h.toHunt();
  h.advance(11_900);
  assert.equal(seeker.inbox.all('hint').length, 0);
  h.advance(200);
  assert.equal(seeker.inbox.all('hint').length, 1);
  h.advance(12_000);
  assert.equal(seeker.inbox.all('hint').length, 2);
  assert.equal(hiders[0].inbox.all('hint').length, 0, 'hiders never get hints');
  const a = seeker.inbox.last('hint')!.a;
  assert.ok(Math.abs(a / (Math.PI / 8) - Math.round(a / (Math.PI / 8))) < 1e-9, 'quantised to 16 directions');
});

test('the round ends cleanly when the seeker disconnects', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  h.room.removePlayer(seeker.id);
  const end = hiders[0].inbox.last('end')!;
  assert.equal(end.reason, 'seeker-left');
  assert.equal(end.winner, null);
  h.advance(h.room.timings.intermissionMs + 10);
  assert.equal(h.room.currentPhase, 'reveal', 'a new round starts with the remaining players');
});

test('the room returns to the lobby when too few players remain', () => {
  const { h, hiders } = startGame();
  h.toHunt();
  h.room.removePlayer(hiders[0].id);
  h.advance(h.room.timings.intermissionMs + 10);
  assert.equal(h.room.currentPhase, 'lobby');
});

test('the host role passes on when the host leaves', () => {
  const h = new Harness();
  const a = h.join('Ann');
  const b = h.join('Bob');
  h.join('Cat');
  h.room.removePlayer(a.id);
  assert.equal(h.room.currentHost, b.id);
  assert.equal(b.inbox.last('room')!.hostId, b.id);
});

const tokenOf = (inbox: Inbox) => inbox.last('welcome')!.token!;

test('a player who reconnects in time keeps their id, host role, role and position', () => {
  const { h, players } = startGame(['Ann', 'Bob', 'Cat']);
  const [ann, bob] = players;
  h.toHunt();
  const maze = h.room.currentMaze!;
  const spot = maze.cellCenter(maze.cellCount - 1);
  h.room.placePlayer(ann.id, spot.x, spot.y);
  const seeker = h.room.currentSeeker;

  bob.inbox.clear();
  h.room.disconnect(ann.id);
  sendInput(h, ann.id, ann.inbox, MAX_STEP, 0);
  h.advance(h.room.timings.reconnectGraceMs - 100);
  assert.deepEqual(h.room.positionOf(ann.id), spot, 'frozen while away');
  assert.equal(h.room.currentHost, ann.id);
  assert.equal(h.room.currentPhase, 'hunt');
  assert.deepEqual(bob.inbox.all('room'), [], 'the others are not told they left');

  const back = new Inbox();
  assert.equal(h.room.resume(tokenOf(ann.inbox), back), ann.id);
  assert.equal(back.last('welcome')!.id, ann.id);
  assert.equal(back.last('room')!.hostId, ann.id);
  const round = back.last('round')!;
  assert.equal(round.n, 1);
  assert.equal(round.seekerId, seeker);
  assert.deepEqual(round.you, spot, 'back where they were, not at a new spawn');
  assert.equal(round.caught, undefined);
  const snap = back.last('snap')!;
  assert.equal(snap.ph, 'hunt', 'the latest state comes straight away');
  assert.deepEqual({ x: snap.you!.x, y: snap.you!.y }, spot);

  // The new connection numbers its inputs from 1 again.
  h.room.handle(ann.id, { t: 'input', r: 1, s: 1, x: MAX_STEP, y: 0 });
  assert.notDeepEqual(h.room.positionOf(ann.id), spot, 'moves again');
  h.advance(h.room.timings.reconnectGraceMs);
  assert.equal(h.room.currentHost, ann.id, 'and is not removed later');
  assert.equal(back.last('snap')!.you!.s, 1);
});

test('the round carries on while the seeker is away, and ends if they do not return', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  h.toHunt();
  const spot = h.room.positionOf(seeker.id);
  h.room.disconnect(seeker.id);
  h.advance(h.room.timings.reconnectGraceMs - 50);
  assert.equal(h.room.currentPhase, 'hunt', 'no pause and no early end');
  assert.deepEqual(h.room.positionOf(seeker.id), spot);
  assert.equal(hiders[0].inbox.all('end').length, 0);

  h.advance(100);
  const end = hiders[0].inbox.last('end')!;
  assert.equal(end.reason, 'seeker-left');
  assert.equal(end.winner, null);
  assert.equal(h.room.positionOf(seeker.id), null, 'their place is gone');
  assert.equal(h.room.resume(tokenOf(seeker.inbox), new Inbox()), null, 'and so is their token');
  h.advance(h.room.timings.intermissionMs + 10);
  assert.equal(h.room.currentPhase, 'reveal', 'the next round starts without them');
});

test('an absent host keeps the role until the grace period runs out', () => {
  const h = new Harness();
  const a = h.join('Ann');
  const b = h.join('Bob');
  h.room.disconnect(a.id);
  h.advance(h.room.timings.reconnectGraceMs - 50);
  assert.equal(h.room.currentHost, a.id);
  h.advance(100);
  assert.equal(h.room.currentHost, b.id);
  const room = b.inbox.last('room')!;
  assert.equal(room.hostId, b.id);
  assert.deepEqual(
    room.players.map((p) => p.id),
    [b.id],
  );
});

test('a resume token only works in its own room', () => {
  const one = new Harness();
  const two = new Harness();
  const ann = one.join('Ann');
  two.join('Bob');
  one.room.disconnect(ann.id);
  assert.equal(two.room.resume(tokenOf(ann.inbox), new Inbox()), null);
  assert.equal(one.room.resume('made-up', new Inbox()), null);
  assert.equal(one.room.resume(tokenOf(ann.inbox), new Inbox()), ann.id);
});

test('resuming while still connected moves the player to the new connection', () => {
  const { h, players } = startGame();
  const ann = players[0];
  const tab = new Inbox();
  assert.equal(h.room.resume(tokenOf(ann.inbox), tab), ann.id);
  assert.equal(ann.inbox.last('error')!.code, 'replaced');
  assert.ok(ann.inbox.closed);
  ann.inbox.clear();
  h.advance(100);
  assert.deepEqual(ann.inbox.messages, [], 'the old connection hears nothing more');
  assert.ok(tab.all('snap').length > 0);
});

test('a caught player comes back caught, and sees the result if the round is over', () => {
  const { h, seeker, hiders } = startGame(['Ann', 'Bob', 'Cat']);
  const [first, second] = hiders;
  h.toHunt();
  const s = h.room.positionOf(seeker.id)!;
  h.room.placePlayer(first.id, s.x + 5, s.y);
  h.advance(20);
  h.room.disconnect(first.id);
  const back = new Inbox();
  h.room.resume(tokenOf(first.inbox), back);
  assert.equal(back.last('round')!.caught, true);

  h.room.placePlayer(second.id, s.x, s.y + 4);
  h.advance(20);
  assert.equal(h.room.currentPhase, 'ended');
  h.room.disconnect(first.id);
  const again = new Inbox();
  h.room.resume(tokenOf(first.inbox), again);
  assert.equal(again.last('round')!.caught, true);
  assert.deepEqual(again.last('end'), second.inbox.last('end'));
});

test('players who are away when a round starts are never picked to seek', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const h = new Harness({ seed });
    const a = h.join('Ann');
    const b = h.join('Bob');
    const c = h.join('Cat');
    h.room.disconnect(b.id);
    h.room.disconnect(c.id);
    h.room.handle(a.id, { t: 'start' });
    assert.equal(h.room.currentSeeker, a.id);
    const back = new Inbox();
    h.room.resume(tokenOf(b.inbox), back);
    assert.ok(back.last('round')!.you, 'they still play the round, as a hider');
  }
});

test('players joining mid-round wait for the next round without seeing anyone', () => {
  const { h, players } = startGame();
  h.toHunt();
  const late = h.join('Late');
  assert.equal(late.inbox.all('round').length, 0);
  const info = late.inbox.last('room')!.players.find((p) => p.id === late.id)!;
  assert.equal(info.waiting, true);
  h.advance(100);
  for (const snap of late.inbox.all('snap')) {
    assert.deepEqual(snap.o, []);
    assert.equal(snap.you, undefined);
  }
  h.advance(90_000 + h.room.timings.intermissionMs);
  assert.equal(late.inbox.last('round')!.n, 2, 'joins the next round');
  assert.equal(players[0].inbox.last('round')!.n, 2);
});

test('a full room refuses more players', () => {
  const h = new Harness();
  for (let i = 0; i < 6; i++) h.join(`P${i}`);
  assert.throws(() => h.join('Extra'));
});
