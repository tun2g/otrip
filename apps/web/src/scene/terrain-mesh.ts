import { createNoise, fbm2d, type GroundPalette, type Terrain } from '@otrip/world';
import { BufferAttribute, Color, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';

import { applyWetLook } from './rain';

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export type TerrainMesh = {
  mesh: Mesh;
  /** Hands the ground the rain's wetness. Call once, with `rain.wetUniform`. */
  setWet: (wet: { value: number }) => void;
  dispose: () => void;
};

/**
 * Flat shading is deliberate: the facets are the look. Colour lives in a vertex
 * attribute so one material paints valley grass, grass line and bare rock
 * without a single texture file.
 */
export const createTerrainMesh = (terrain: Terrain, ground: GroundPalette, seed: string): TerrainMesh => {
  const geometry = new PlaneGeometry(terrain.size, terrain.size, terrain.segments, terrain.segments);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position as BufferAttribute;
  const colors = new Float32Array(position.count * 3);

  // Patchiness. Three colour bands over four square kilometres reads as paint;
  // a slow noise over the top reads as grass, scrub and bare patches.
  const patchNoise = createNoise(`${seed}:patch`);
  const hsl = { h: 0, s: 0, l: 0 };

  // Taken as authored. The chroma these need to carry belongs in the recipe, so
  // that the grass, the scatter and the terraces standing on this hillside are
  // painted from the same numbers; lifting it here instead left the terrain
  // green and everything growing on it grey.
  const low = new Color(ground.low);
  const mid = new Color(ground.mid);
  const high = new Color(ground.high);
  const rock = new Color(ground.rock);
  const scratch = new Color();

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const y = terrain.heightAt(x, z);
    position.setY(i, y);

    const altitude = y / terrain.maxHeight;
    scratch.copy(low);
    scratch.lerp(mid, smoothstep(0.06, 0.42, altitude));
    scratch.lerp(high, smoothstep(0.62, 1.0, altitude));
    // Bare rock only on genuinely steep faces. Counted over the real
    // heightfield, the previous 0.95 ramp still painted 27.2% of Tà Xùa as more
    // than half rock — a quarter of a ridge whose own recipe grows trees to
    // within 40 m of the summit, and the grey that reading made is most of what
    // was left of the washed-out look once the palettes were lifted. At this
    // ramp it is 11.3%, which is the cliffs and the scree and not the pasture,
    // and the mean vertex colour goes from 36.0% to 43.6% saturation. The other
    // three are flat enough that it barely reaches them: Hội An and Hồ Tây are
    // at 0% either way, Tràng An 5.9% to 1.9%.
    scratch.lerp(rock, smoothstep(1.6, 2.65, terrain.slopeAt(x, z)));

    const patch = fbm2d(patchNoise, x, z, { octaves: 3, frequency: 0.004, lacunarity: 2.1, gain: 0.5 });
    scratch.getHSL(hsl);
    scratch.setHSL(
      hsl.h + patch * 0.012,
      Math.min(1, Math.max(0, hsl.s + patch * 0.06)),
      Math.min(1, Math.max(0.03, hsl.l + patch * 0.055))
    );

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  position.needsUpdate = true;
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'terrain';

  return {
    mesh,
    // High pooling: the valley floor soaks, the cliffs the rock band paints shed
    // the water and stay the colour they were.
    setWet: (wet) => applyWetLook(material, wet, { darken: 0.34, gloss: 0.6, pooling: 0.78 }),
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
};
