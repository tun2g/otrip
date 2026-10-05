export type Obstacle = {
  x: number;
  z: number;
  radius: number;
  /** World height of the base and the top, for vertical overlap tests. */
  bottom: number;
  top: number;
};

export type ObstacleIndex = {
  /**
   * Obstacles whose cell touches this point. Cheap enough to call per sample.
   * Pass `into` to be given that array back filled; otherwise the index reuses
   * one of its own. Either way the result is only good until the next call.
   */
  near: (x: number, z: number, into?: Obstacle[]) => Obstacle[];
};

const CELL = 60;

/**
 * A uniform grid over the obstacles. Several thousand trees cannot be scanned
 * once per camera sample per frame, but the handful in the neighbouring cells
 * can — and without this the camera happily buries itself in a tree crown.
 */
export const createObstacleIndex = (obstacles: Obstacle[]): ObstacleIndex => {
  const cells = new Map<string, Obstacle[]>();
  const keyOf = (x: number, z: number) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

  for (const obstacle of obstacles) {
    const key = keyOf(obstacle.x, obstacle.z);
    const bucket = cells.get(key);
    if (bucket) bucket.push(obstacle);
    else cells.set(key, [obstacle]);
  }

  // Filled rather than built: `near` runs several times per collision sample per
  // frame, and concatenating up to nine buckets allocated a fresh array each time.
  const own: Obstacle[] = [];

  return {
    near: (x, z, into) => {
      const found = into ?? own;
      found.length = 0;
      const cellX = Math.floor(x / CELL);
      const cellZ = Math.floor(z / CELL);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = cells.get(`${cellX + dx}:${cellZ + dz}`);
          if (!bucket) continue;
          for (const obstacle of bucket) found.push(obstacle);
        }
      }

      return found;
    },
  };
};
