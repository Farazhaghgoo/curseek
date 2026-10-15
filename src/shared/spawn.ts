import type { Maze } from './maze';
import { randInt, type Rng } from './rng';

export interface SpawnPlan {
  seeker: number;
  hiders: number[];
}

/**
 * Picks spawn cells: the seeker anywhere, hiders in a band of cells that are far from the seeker
 * along the maze, spread out from each other by greedy farthest-point selection.
 */
export function chooseSpawns(maze: Maze, rng: Rng, hiderCount: number): SpawnPlan {
  const cells = maze.cellCount;
  const seeker = randInt(rng, cells);
  const fromSeeker = maze.distancesFrom(seeker);
  let maxDist = 0;
  for (let i = 0; i < cells; i++) maxDist = Math.max(maxDist, fromSeeker[i]);

  const band = Math.max(4, Math.floor(maxDist * 0.45));
  let pool: number[] = [];
  for (let i = 0; i < cells; i++) if (fromSeeker[i] >= band) pool.push(i);
  if (pool.length < hiderCount) {
    pool = [];
    for (let i = 0; i < cells; i++) if (i !== seeker) pool.push(i);
  }

  // Score each candidate by its distance to the nearest already-chosen spawn (seeker included).
  const nearest = Array.from(fromSeeker, (d) => (d < 0 ? 0 : d));
  const hiders: number[] = [];
  for (let k = 0; k < hiderCount; k++) {
    const ranked = pool
      .filter((c) => !hiders.includes(c))
      .sort((a, b) => nearest[b] - nearest[a])
      .slice(0, 6);
    const pick = ranked[randInt(rng, ranked.length)];
    hiders.push(pick);
    const fromPick = maze.distancesFrom(pick);
    for (let i = 0; i < cells; i++) nearest[i] = Math.min(nearest[i], fromPick[i]);
  }
  return { seeker, hiders };
}
