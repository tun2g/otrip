import type { LocationRecipe } from '@otrip/world';
import { Color, DoubleSide, MeshStandardMaterial } from 'three';

import { applyWetLook, type WetLookOptions } from './rain';

/**
 * The town's whole palette, shared by every building so that what repeats can
 * be instanced. Lit panes, lanterns and signs are materials rather than light
 * sources: their emissive rides up as the sun goes down and the bloom pass
 * turns it into a glow. Real point lights would have meant one per window.
 */
export type KitMaterial = {
  /** Five shades of street paint. A terrace where every wall matches is a tell. */
  plaster: MeshStandardMaterial[];
  /** The Hội An wash. Fixed rather than recipe-derived: the colour is the place. */
  ochre: MeshStandardMaterial;
  ochreDeep: MeshStandardMaterial;
  whitewash: MeshStandardMaterial;
  concrete: MeshStandardMaterial;
  concreteWorn: MeshStandardMaterial;
  screed: MeshStandardMaterial;
  paving: MeshStandardMaterial;
  grime: MeshStandardMaterial;
  moss: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  brick: MeshStandardMaterial;
  tile: MeshStandardMaterial;
  tileDark: MeshStandardMaterial;
  tileOld: MeshStandardMaterial;
  /** Glazed ridge and tier tiles — pagoda roofs, not houses. */
  tileGlazed: MeshStandardMaterial;
  metal: MeshStandardMaterial;
  metalRust: MeshStandardMaterial;
  metalPale: MeshStandardMaterial;
  thatch: MeshStandardMaterial;
  bamboo: MeshStandardMaterial;
  timberDark: MeshStandardMaterial;
  timberMid: MeshStandardMaterial;
  timberPale: MeshStandardMaterial;
  woven: MeshStandardMaterial;
  /** Unlit glass. Used where nobody is home, so it stays dark after dusk. */
  glass: MeshStandardMaterial;
  windowWarm: MeshStandardMaterial;
  windowCool: MeshStandardMaterial;
  windowTv: MeshStandardMaterial;
  shopGlow: MeshStandardMaterial;
  lanternRed: MeshStandardMaterial;
  lanternGold: MeshStandardMaterial;
  signRed: MeshStandardMaterial;
  signLit: MeshStandardMaterial;
  clothRed: MeshStandardMaterial;
  clothTeal: MeshStandardMaterial;
  clothCream: MeshStandardMaterial;
  foliage: MeshStandardMaterial;
  foliageDark: MeshStandardMaterial;
  produce: MeshStandardMaterial;
  straw: MeshStandardMaterial;
  gold: MeshStandardMaterial;
  lacquer: MeshStandardMaterial;
  earth: MeshStandardMaterial;
  rope: MeshStandardMaterial;
};

type NightMaterial = { material: MeshStandardMaterial; peak: number; flicker: number };

export type MaterialKit = {
  mat: KitMaterial;
  /** Hands the town's masonry, tile, timber and metal the rain's wetness. */
  setWet: (wet: { value: number }) => void;
  setNight: (amount: number) => void;
  /** Only the flickering materials move per frame; everything else is static. */
  update: (elapsed: number) => void;
  dispose: () => void;
};

const shade = (base: Color, hue: number, saturation: number, lightness: number): Color => {
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  return new Color().setHSL(
    (hsl.h + hue + 1) % 1,
    Math.min(1, Math.max(0, hsl.s + saturation)),
    Math.min(1, Math.max(0.02, hsl.l + lightness))
  );
};

export const createMaterialKit = (recipe: LocationRecipe): MaterialKit => {
  const materials: MeshStandardMaterial[] = [];
  const nightMaterials: NightMaterial[] = [];

  const surface = (color: Color | string, roughness: number, doubleSided = false) => {
    const material = new MeshStandardMaterial({
      color,
      flatShading: true,
      roughness,
      metalness: 0,
      // Passing `side: undefined` is not the same as omitting it — three warns.
      ...(doubleSided ? { side: DoubleSide } : {}),
    });
    materials.push(material);
    return material;
  };

  const lit = (color: string, emissive: string, peak: number, flicker = 0) => {
    const material = new MeshStandardMaterial({
      color,
      emissive: new Color(emissive),
      emissiveIntensity: 0,
      flatShading: true,
      roughness: 0.55,
      metalness: 0,
    });
    materials.push(material);
    nightMaterials.push({ material, peak, flicker });
    return material;
  };

  const wallBase = new Color(recipe.town?.wall ?? recipe.ground.high);
  const roofBase = new Color(recipe.town?.roof ?? recipe.ground.roof);
  const foliageBase = new Color(recipe.ground.foliage);

  const mat: KitMaterial = {
    plaster: [
      surface(wallBase, 0.94),
      surface(shade(wallBase, 0.012, -0.04, 0.07), 0.94),
      surface(shade(wallBase, -0.02, 0.05, -0.06), 0.94),
      surface('#b9c7b4', 0.94),
      surface('#c8b89a', 0.94),
    ],
    ochre: surface('#d9ac5a', 0.94),
    ochreDeep: surface('#c08f3c', 0.94),
    whitewash: surface('#dcd8cc', 0.95),
    concrete: surface('#b0aca4', 0.95),
    concreteWorn: surface('#9a978f', 0.96),
    screed: surface('#8e8b83', 0.97),
    paving: surface('#a09b90', 0.96),
    grime: surface('#6d6a60', 0.98),
    moss: surface('#5d6b4a', 0.97),
    stone: surface('#8d897e', 0.95),
    brick: surface('#8d5a46', 0.95),
    tile: surface(roofBase, 0.9),
    tileDark: surface(shade(roofBase, 0, 0.02, -0.1), 0.9),
    tileOld: surface(shade(roofBase, 0.02, -0.12, -0.04), 0.93),
    tileGlazed: surface('#4c5f4a', 0.45),
    metal: surface('#8f9499', 0.72),
    metalRust: surface('#7d5a46', 0.86),
    metalPale: surface('#c4c8cb', 0.6, true),
    thatch: surface('#9a8356', 0.97, true),
    bamboo: surface('#a8a062', 0.9),
    timberDark: surface('#4a3729', 0.92),
    timberMid: surface('#6f5538', 0.9),
    timberPale: surface('#9c7c52', 0.9),
    woven: surface('#c0ab83', 0.96, true),
    glass: surface('#262d33', 0.35),
    windowWarm: lit('#2a2b28', '#ffb366', 3.1),
    windowCool: lit('#2b2f33', '#cfe3ff', 2.6),
    windowTv: lit('#25292e', '#9fd0ff', 2.8, 0.55),
    shopGlow: lit('#30302c', '#ffd79a', 2.4),
    lanternRed: lit('#8e2a1c', '#ff6a3a', 3.4),
    lanternGold: lit('#9a7320', '#ffc263', 3.4),
    signRed: surface('#9c3327', 0.85),
    signLit: lit('#2e2b26', '#ffd36a', 2.2),
    clothRed: surface('#a8442c', 0.94, true),
    clothTeal: surface('#51807c', 0.94, true),
    clothCream: surface('#d8cfb4', 0.94, true),
    foliage: surface(foliageBase, 0.95, true),
    foliageDark: surface(shade(foliageBase, 0, 0.03, -0.06), 0.95, true),
    produce: surface('#b8762a', 0.9),
    straw: surface('#c2a768', 0.96, true),
    gold: surface('#b08a3c', 0.5),
    lacquer: surface('#7d2520', 0.7),
    earth: surface(new Color(recipe.ground.low), 0.98),
    rope: surface('#8d8268', 0.96),
  };

  /**
   * What rain actually changes about a building, and how hard. Left out on
   * purpose: glass and every lit material, where darkening the albedo dims a
   * window for nothing; cloth, paper lanterns and foliage, which the eye reads
   * as hanging and moving rather than as surface; and gold and lacquer, which
   * are already the shiniest things in a pagoda.
   */
  const wet: [MeshStandardMaterial[], WetLookOptions][] = [
    // Fired tile and sheet metal are the roofs, and a roof is the one part of a
    // building the sky lands on squarely, so this is nearly all of the effect.
    [[mat.tile, mat.tileDark, mat.tileOld, mat.tileGlazed], { darken: 0.3, gloss: 0.84, pooling: 0.55 }],
    [[mat.metal, mat.metalRust, mat.metalPale], { darken: 0.24, gloss: 0.88, pooling: 0.5 }],
    [
      // Masonry. Pooling does the work here: a rendered wall sheds the water and
      // stays its own colour, while the sill and the step below it go dark.
      [
        ...mat.plaster,
        mat.ochre,
        mat.ochreDeep,
        mat.whitewash,
        mat.concrete,
        mat.concreteWorn,
        mat.screed,
        mat.paving,
        mat.grime,
        mat.stone,
        mat.brick,
        mat.earth,
      ],
      { darken: 0.34, gloss: 0.55, pooling: 0.78 },
    ],
    // Thatch, bamboo and bare timber drink it instead of reflecting it.
    [
      [mat.thatch, mat.straw, mat.woven, mat.bamboo, mat.rope, mat.timberDark, mat.timberMid, mat.timberPale],
      { darken: 0.4, gloss: 0.3, pooling: 0.6 },
    ],
    [[mat.moss], { darken: 0.36, gloss: 0.45, pooling: 0.7 }],
  ];

  let night = 0;

  return {
    mat,
    setWet: (value) => {
      for (const [group, options] of wet) {
        for (const material of group) applyWetLook(material, value, options);
      }
    },
    setNight: (amount) => {
      night = Math.min(1, Math.max(0, amount));
      // The flickering ones get their steady value here too: `update` has not
      // run yet on the frame the sun goes down, and a window that stays black
      // for that frame is the one the eye catches.
      for (const entry of nightMaterials) {
        entry.material.emissiveIntensity = entry.peak * night * (1 - entry.flicker * 0.5);
      }
    },
    update: (elapsed) => {
      for (const entry of nightMaterials) {
        if (entry.flicker === 0) continue;
        // A television is the one window in the street that never holds still.
        const jitter = Math.sin(elapsed * 11.3) * 0.5 + Math.sin(elapsed * 27.7) * 0.3 + Math.sin(elapsed * 4.1) * 0.2;
        entry.material.emissiveIntensity = entry.peak * night * (1 - entry.flicker * (0.5 + jitter * 0.5));
      }
    },
    dispose: () => {
      for (const material of materials) material.dispose();
      materials.length = 0;
      nightMaterials.length = 0;
    },
  };
};
