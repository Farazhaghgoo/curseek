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

- **Mouse:** press **Tab** (or click the maze) and the mouse steers your cursor. Press **Tab**
  again (or **Esc**) and it is your ordinary pointer once more, for the buttons. Your cursor
  moves at up to a fixed maximum speed and slides along walls.
- **Keyboard:** **WASD** or the **arrow keys**. Diagonal movement is no faster than straight
  movement.
- **Touch:** touch anywhere on the maze and drag. A joystick appears under your finger, and
  the further you drag, the faster you move, up to the same top speed. On a phone, turn it
  sideways for a bigger maze.
- **M** mutes or unmutes the sound. The speaker button in the top-right corner does the same.
- The **✕** button leaves the room.

The game captures the mouse with pointer lock. If the browser refuses it (for example inside
some embedded frames and app panes), your cursor chases the mouse pointer instead, which
shows as a crosshair: point where you want to go.

## Rules

- At the start of each round you get a new maze and a new seeker. The seeker role rotates
  through the players in join order.
- The host can change the hunt length, the hint interval and how long the maze is shown, in
  the lobby between games. The defaults are below.
- **Reveal (3 s):** the whole maze is visible, but other players are not. Hiders can
  already move. The seeker is frozen.
- **Fade (2 s):** the maze fades to darkness. The seeker is still frozen.
- **Hunt (90 s):** everyone sees only a small lit area around themselves. Walls block both
  movement and sight.
- The seeker (the red crosshair) catches a hider by touching them. A wall between the two
  players prevents the catch.
- Every 12 seconds the seeker sees a brief red arc on the edge of their light. It points
  roughly (one of 16 directions) toward the nearest surviving hider. In the final 30
  seconds it comes every 4 seconds, so hiding in a dead end until time runs out is risky.
- The seeker wins by catching every hider. If any hider is still free when time runs out,
  the hiders win.
- Caught hiders watch the rest of the round from the seeker's point of view.
- Players who join during a round watch it from the seeker's point of view, and play from the
  next one.
- **Scores** carry over from round to round: the seeker gets a point per catch, every
  hider still free when time runs out gets a point, and every coin is a point. They show on
  the results screen and in the lobby.

## Perks, curses and coins

Five violet **? orbs** and six gold **coins** lie in the maze. You see them all during the
reveal; after that, only inside your light. They can be picked up during the hunt only, by
touching them. A taken orb turns up somewhere else 8 seconds later, a coin 10 seconds later,
never close to a player.

A coin is worth a point. An orb is a mystery until you touch it: it gives a random effect for
a few seconds, usually a perk, sometimes a curse. Your running effects show in the corner
with the time they have left. Picking up the same effect again extends it.

| Effect | Who can get it | What it does |
|---|---|---|
| Speed boost | anyone | 1.6× top speed for 5 s |
| Flare | anyone | your light reaches twice as far for 8 s |
| Phase | anyone | you pass through walls for 4 s; if it ends inside a wall, you are pushed out of it |
| Cloak | hiders | the seeker cannot see you for 6 s, and the seeker's hints ignore you (a touch still catches you) |
| Radar | seeker | every hider who isn't cloaked shows up, through walls, for 2 s |
| Slow (curse) | anyone | 0.55× top speed for 4 s |
| Blind (curse) | anyone | your light shrinks to under half for 6 s |
| Beacon (curse) | anyone | the other side sees where you are, through walls, for 4 s |

Walls still block catches during Phase. Bots pick up what they see too.

## How it works

```
src/shared/   world constants, maze generation, collision, line of sight, perks, protocol (used by both sides)
src/sim/      the authoritative game: rooms, rounds, roles, captures, hints, pickups and effects, bots
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
  within their light radius, with clear line of sight, and not cloaked from them. Players
  shown by the radar or a beacon travel separately, as marks. A capture's location is only
  sent to players who could see it, and hints are only a coarse direction. The client
  renders the light as a visibility polygon clipped by the walls, with a soft radial falloff.
- **Effects.** The server rolls and times every effect, and applies speed and phase to the
  inputs it accepts. Each snapshot tells a player their own running effects, so the client
  can predict its movement and size its light; whoever picks up an orb is also told at once.
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

- `GET /healthz` answers `{"ok":true,...}` with the number of open rooms and connections.
  The Docker image uses it as its health check, and runs as the unprivileged `node` user.
- Only pages from the game's own host may open the WebSocket (the `Origin` header must match
  `Host`). Each client address may hold 24 connections, the server 3000, and at most 500
  rooms can be open. Connections that are not in a room are closed after a minute.
- Behind a reverse proxy (as on Render, Fly.io or Railway), set `TRUST_PROXY=1` so the
  per-address limit uses the real client address from `X-Forwarded-For`. Without it, every
  player appears to come from the proxy and shares one limit.
- When the server shuts down (`SIGTERM`), players are told their game has ended rather than
  left to retry.

## Assumptions and decisions

- Hiders cannot see each other through walls either: everyone sees only their own lit area.
- Players do not collide with each other. Only walls block movement.
- Caught hiders leave the field and spectate the seeker's view.
- If a player's connection drops, or they reload the page, the server holds their place for
  10 seconds. They keep their role, position and caught state, and their cursor stays frozen
  where it was. Everyone else sees them faded and marked as away. The client reconnects on
  its own, or on reload, and carries on in the same round. A player who is away when a new
  round starts plays it as a hider, never as the seeker.
- While the seeker is away, the hunt clock and their hints stop, so they lose no time.
  Hiders can still move, and the frozen seeker still catches any hider who touches them.
- A host who drops out keeps the role during a round. In the lobby it passes on at once, so
  the others can still start.
- The host can remove any other player from the lobby list. A removed player can join again
  with the room code; there are no bans.
- A player who leaves with the ✕ button is removed at once. So is a dropped player who is
  not back within 10 seconds. If the seeker is removed, the round ends with no winner and
  the next round starts with a new seeker. If the host is removed, the next player who
  joined becomes host. If fewer than two players remain, the room returns to the lobby. A
  room closes when its last human player is gone.
- Rounds continue automatically after a 6-second results screen.
- In solo play a bot seeks first, so the first round is about hiding.
- Bots know the maze layout, which every player saw during the reveal. They only notice
  opponents through the same line-of-sight test players are subject to. The seeker bot
  uses the same direction hints a human seeker gets.

## Known limitations

- Rooms are held in a single server process. Restarting the server ends all games, and the
  server cannot be scaled horizontally without sticky routing.
- A dropped player can take their place back only within 10 seconds, and only from the same
  browser tab: the resume token lives in that tab's session storage. After that, joining
  again makes them a new player who waits for the next round. Only the seeker's absence
  stops the clock.
- Without pointer lock (the fallback mode), your cursor heads straight for the pointer and
  slides along any wall in the way; it does not find a path around corners, so point along
  the corridor you want. Keyboard controls always work.
- The maze is landscape-shaped, so on a phone held upright it is small. Touch controls have
  been tested with simulated touch events, not yet on real phones.
- With large network jitter (more than about 150 ms), the server's speed limiter may trim
  movement, which shows up as small corrections.
