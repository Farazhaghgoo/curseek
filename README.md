# curseek

Multiplayer hide-and-seek for mouse cursors, in a dark maze. One player seeks, everyone
else hides. You see the whole maze for three seconds. Then the lights go out and you only
see a small glow around your own cursor.

## Run it

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. To try it on your own, choose **Play solo**. That game runs
against three bots entirely in the browser.

To play with friends, choose **Create room** and share the four-letter code or the invite
link. Friends open the link, or enter the code, and choose **Join room**. Rooms hold 2–6
players. The host can add bots to fill a room.

Production build:

```bash
npm run build
npm start            # serves the game and the WebSocket endpoint on $PORT (default 3000)
```

Checks:

```bash
npm run check        # TypeScript type check + all tests
```

## Controls

- **Mouse:** click the maze to capture the mouse (pointer lock), then move. Your cursor
  moves at up to a fixed maximum speed and slides along walls. Press **Esc** to release
  the mouse, and click again to resume.
- **Keyboard:** **WASD** or the **arrow keys**. Diagonal movement is no faster than straight
  movement.
- **M** mutes or unmutes the sound. The speaker button in the top-right corner does the same.
- The **✕** button leaves the room.

If the browser refuses pointer lock (for example inside some embedded frames), the mouse
moves your cursor directly while the pointer is over the maze.

## Rules

- At the start of each round you get a new maze and a new seeker. The seeker role rotates
  through the players in join order.
- **Reveal (3 s):** the whole maze is visible, but other players are not. Hiders can
  already move. The seeker is frozen.
- **Fade (2 s):** the maze fades to darkness. The seeker is still frozen.
- **Hunt (90 s):** everyone sees only a small lit area around themselves. Walls block both
  movement and sight.
- The seeker (the red crosshair) catches a hider by touching them. A wall between the two
  players prevents the catch.
- Every 12 seconds the seeker sees a brief red arc on the edge of their light. It points
  roughly (one of 16 directions) toward the nearest surviving hider.
- The seeker wins by catching every hider. If any hider is still free when time runs out,
  the hiders win.
- Caught hiders watch the rest of the round from the seeker's point of view.
- Players who join during a round wait for the next one.

## How it works

```
src/shared/   world constants, maze generation, collision, line of sight, protocol (used by both sides)
src/sim/      the authoritative game: rooms, rounds, roles, captures, hints, bots
src/server/   HTTP static files + WebSocket rooms (wraps src/sim)
src/client/   input, prediction/reconciliation, interpolation, Canvas renderer, DOM overlays, sound
test/         unit, room-simulation, server and end-to-end tests (node:test)
```

- **One authoritative simulation.** `GameRoom` (`src/sim/room.ts`) owns all game state. It
  has no networking or timers of its own. The server drives it for multiplayer rooms. In
  solo play the browser runs the same class behind an in-memory transport, so solo and
  multiplayer share a single code path.
- **Input, not positions.** Clients send one movement request per 60 Hz tick. The server
  clamps each request to the maximum step and applies a token bucket, so flooding inputs
  cannot make anyone faster. It then moves the player with the same collision code the
  client uses. Captures, timers, roles and results are all decided on the server.
- **Collision.** Players are circles and walls are capsules. Movement is split into
  1.5-unit substeps, much shorter than a wall's effective thickness, so no input can
  tunnel through a wall. Pushing out along the nearest surface makes players slide along
  walls and round wall ends.
- **Visibility.** Each snapshot sent to a player contains only the opponents they can see:
  within their light radius, with clear line of sight. A capture's location is only sent
  to players who could see it, and hints are only a coarse direction. The client renders
  the light as a visibility polygon clipped by the walls, with a soft radial falloff.
- **Netcode.** The local player is predicted immediately and reconciled against the
  server's acknowledged input sequence. Any correction is smoothed out over about 90 ms.
  Remote players are interpolated about 100 ms behind the estimated server clock.
- **Screen size.** The world has fixed dimensions (25 × 14 cells) for every player. A
  window resize only changes the view scale. Mouse movement is converted to world units
  and capped at the same maximum speed everywhere.

## Hosting

The game needs one long-running Node.js process that accepts WebSocket connections. Rooms
live in memory. Good fits are Render, Fly.io, Railway or any VPS. A `Dockerfile` is
included:

```bash
docker build -t curseek .
docker run -p 3000:3000 curseek
```

Serverless function platforms (such as Vercel or Netlify Functions) are not suitable: they
do not keep WebSocket connections or in-memory rooms alive. Serve the game over HTTPS in
production; the client switches to `wss://` automatically.

## Assumptions and decisions

- Hiders cannot see each other through walls either: everyone sees only their own lit area.
- Players do not collide with each other. Only walls block movement.
- Caught hiders leave the field and spectate the seeker's view.
- If the seeker disconnects, the round ends with no winner and the next round starts with a
  new seeker. If the host leaves, the next player who joined becomes host. If fewer than
  two players remain, the room returns to the lobby. A room closes when its last human
  player leaves.
- Rounds continue automatically after a 6-second results screen.
- In solo play a bot seeks first, so the first round is about hiding.
- Bots know the maze layout, which every player saw during the reveal. They only notice
  opponents through the same line-of-sight test players are subject to. The seeker bot
  uses the same direction hints a human seeker gets.

## Known limitations

- Rooms are held in a single server process. Restarting the server ends all games, and the
  server cannot be scaled horizontally without sticky routing.
- A disconnected player cannot rejoin into the same slot; reconnecting joins as a new
  player who waits for the next round.
- Without pointer lock (the fallback mode), the mouse stops moving your cursor when the
  hidden system pointer reaches the edge of the window. Keyboard controls always work.
- The game is designed for desktop browsers. Touch input is not supported, and on narrow
  portrait screens the maze is small.
- With large network jitter (more than about 150 ms), the server's speed limiter may trim
  movement, which shows up as small corrections.
