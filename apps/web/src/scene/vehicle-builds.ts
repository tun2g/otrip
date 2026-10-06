/**
 * The eight machines, each as a list of parts grouped by what moves it.
 *
 * Nothing here touches a material, a mesh or the scene graph: a `Build` is
 * geometry and colours in the vehicle's own coordinates, and `vehicle-kit.ts` is
 * the one place that knows where a node sits. That division is why the same
 * builder serves the fleet driving the centrelines, the bike parked at the kerb
 * that the player takes, and a companion's machine drawn from the room's
 * `heading` — three consumers, one description of a xe máy.
 */
import { SphereGeometry, TorusGeometry } from 'three';

import { box, strut, tube, type Part } from './road-network';
import { archLift, cartWheel, dress, loft, pick, RIGHT, slab, seatedRider, SKIN, wheel } from './vehicle-parts';
import { SPECS, type VehicleKind } from './vehicle-specs';

/** The paint the fleet is dealt out of. */
export const PAINT = ['#b23a2e', '#2f4858', '#c9c3b4', '#3f6049', '#d9b24c', '#6f5a7d', '#1f2a33', '#a8562e'];

/**
 * Everything one vehicle is made of, grouped by what moves it. Every list is in
 * the vehicle's own coordinates with y = 0 at the tyre contact patch; the
 * assembler is what shifts a list into the frame of the node that carries it.
 */
export type Build = {
  /** Static bodywork. Merged into one vertex-coloured geometry, so one draw call. */
  body: Part[];
  glass: Part[];
  /** Fork, bars, front mudguard — whatever turns with the steering. */
  steer: Part[];
  frontWheel: Part[];
  rearWheel: Part[];
  /** Leans and bobs with the machine. */
  rider: Part[];
  /** Pivots about X, for cranks that are pedalled and legs that walk. */
  swing: { parts: Part[]; at: [number, number, number]; phase: number; gain: number }[];
  head: Part[];
  tail: Part[];
  /** Where the headlight glow cone starts. Null means it carries no lights. */
  lamp: [number, number, number] | null;
};

const emptyBuild = (): Build => ({
  body: [],
  glass: [],
  steer: [],
  frontWheel: [],
  rearWheel: [],
  rider: [],
  swing: [],
  head: [],
  tail: [],
  lamp: null,
});

// --- xe máy -------------------------------------------------------------------

export const motorbikeBuild = (paint: string, cargo: boolean, random: () => number, solo = false): Build => {
  const build = emptyBuild();
  const spec = SPECS.motorbike;
  const dark = '#2a2d31';
  const chrome = '#b9bdc0';

  build.body.push(
    box([0.3, 0.26, 0.42], [0, 0.34, -0.04], dark),
    tube([0.07, 0.075], 0.22, [0, 0.47, 0.11], '#8d9296', [1.15, 0, 0], 8),
    box([0.12, 0.09, 0.66], [0, 0.68, -0.32], dark),
    box([0.24, 0.17, 0.34], [0, 0.63, -0.2], paint),
    box([0.3, 0.22, 0.46], [0, 0.46, -0.16], paint),
    box([0.34, 0.4, 0.1], [0, 0.6, 0.4], paint),
    box([0.26, 0.04, 0.38], [0, 0.24, 0.13], dark),
    box([0.27, 0.1, 0.62], [0, 0.76, -0.22], '#23242a'),
    box([0.2, 0.08, 0.17], [0, 0.755, 0.11], '#23242a'),
    box([0.26, 0.03, 0.27], [0, 0.805, -0.56], chrome),
    box([0.16, 0.11, 0.015], [0, 0.44, -0.79], '#e6e3d8'),
    box([0.17, 0.04, 0.3], [0, 0.49, -0.64], dark)
  );

  // A step-through has no top tube, so the line from the steering head down to
  // the engine is most of what there is to recognise it by.
  build.body.push(
    strut([0, 0.86, 0.5], [0, 0.44, 0.1], 0.032, dark, 6),
    strut([0, 0.86, 0.5], [0, 0.69, -0.02], 0.028, dark, 6),
    strut([RIGHT * 0.09, 0.33, -0.1], [RIGHT * 0.15, 0.25, -0.46], 0.028, chrome, 6),
    tube([0.05, 0.045], 0.34, [RIGHT * 0.16, 0.26, -0.66], chrome, [Math.PI / 2, 0, 0], 8)
  );
  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * 0.095, 0.34, -0.1], [side * 0.08, 0.215, -0.6], 0.022, dark, 5),
      strut([side * 0.09, 0.64, -0.28], [side * 0.085, 0.3, -0.58], 0.026, '#6f757a', 6),
      box([0.11, 0.035, 0.09], [side * 0.17, 0.26, -0.02], dark)
    );
  }

  build.rearWheel.push(...wheel(spec.wheelRadius, 0.1, 0, 7));
  build.frontWheel.push(...wheel(spec.wheelRadius, 0.09, 0, 7));

  // Steering assembly, in vehicle coordinates — the assembler rebases it.
  const axle = spec.frontAxle;
  const bars = axle - 0.14;
  build.steer.push(
    box([0.17, 0.07, 0.11], [0, 0.75, axle + 0.02], dark),
    box([0.14, 0.06, 0.4], [0, 0.4, axle + 0.02], paint),
    box([0.2, 0.18, 0.13], [0, 0.86, axle + 0.01], dark),
    tube([0.017, 0.017], 0.62, [0, 0.9, bars], '#6f757a', [0, 0, Math.PI / 2], 6),
    box([0.14, 0.07, 0.1], [0, 0.99, bars - 0.05], dark)
  );
  for (const side of [-1, 1]) {
    build.steer.push(
      strut([side * 0.075, 0.72, axle + 0.04], [side * 0.075, 0.215, axle], 0.024, chrome, 6),
      tube([0.023, 0.023], 0.11, [side * 0.26, 0.9, bars], '#1f2024', [0, 0, Math.PI / 2], 6),
      strut([side * 0.21, 0.92, bars], [side * 0.27, 1.1, bars - 0.01], 0.012, '#6f757a', 4),
      box([0.12, 0.07, 0.02], [side * 0.27, 1.13, bars - 0.01], '#cfd4d6', [0, 0, side * 0.2]),
      box([0.11, 0.05, 0.03], [side * 0.14, 0.75, axle + 0.09], '#e2a43c')
    );
  }
  build.head.push(box([0.16, 0.12, 0.03], [0, 0.86, axle + 0.09], '#ffffff'));
  build.tail.push(box([0.11, 0.06, 0.025], [0, 0.56, -0.79], '#ffffff'));
  build.lamp = [0, 0.86, axle + 0.12];

  build.rider.push(
    ...seatedRider(
      [0, 0.86, -0.18],
      [0, 0.9, 0.48],
      [0, 0.29, -0.02],
      dress(random, random() < 0.78 ? 'helmet' : 'non-la'),
      0.26,
      {
        grip: 0.26,
        foot: 0.17,
      }
    )
  );

  if (!cargo && !solo && random() < 0.55) {
    // Two up is the normal way to carry a second person here, and the pillion
    // sits square where the rider is folded forward over the bars. Never on one
    // the player can take: a passenger who appears the moment you sit down is a
    // ghost, and the figure on a parked bike is the one you become.
    build.rider.push(
      ...seatedRider(
        [0, 0.88, -0.56],
        [0, 0.78, -0.3],
        [0, 0.3, -0.42],
        dress(random, random() < 0.6 ? 'helmet' : 'none'),
        0.08,
        { grip: 0.16, foot: 0.19 }
      )
    );
  }

  if (cargo) {
    // Loaded past any sensible limit, which is the point of the variant: crates
    // up the back, panniers either side, cord criss-crossed over the lot.
    const crates = 2 + Math.floor(random() * 2);
    let stack = 0.82;
    for (let c = 0; c < crates; c += 1) {
      const tall = 0.2 + random() * 0.08;
      build.body.push(
        box(
          [0.52 - c * 0.06, tall, 0.42 - c * 0.04],
          [0, stack + tall / 2, -0.56],
          c % 2 === 0 ? '#9a7b4f' : '#7c6a52',
          [0, (random() - 0.5) * 0.14, 0]
        )
      );
      stack += tall;
    }
    for (const side of [-1, 1]) {
      build.body.push(
        tube([0.2, 0.15], 0.34, [side * 0.34, 0.56, -0.5], '#b39a6e', undefined, 12),
        tube([0.21, 0.21], 0.03, [side * 0.34, 0.73, -0.5], '#8d7a55', undefined, 12)
      );
    }
    build.body.push(
      strut([-0.3, 0.76, -0.56], [0.3, stack - 0.04, -0.56], 0.012, '#4a4335', 4),
      strut([0.3, 0.76, -0.56], [-0.3, stack - 0.04, -0.56], 0.012, '#4a4335', 4)
    );
  }

  return build;
};

// --- xe con -------------------------------------------------------------------

const carBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.car;
  const dark = '#23262a';
  const chrome = '#b4b9bc';
  const half = spec.width / 2;
  const axles = [spec.frontAxle, spec.rearAxle];

  const stations: number[] = [];
  for (let i = 0; i <= 26; i += 1) stations.push(-2.15 + (i / 26) * 4.3);

  build.body.push(
    loft(
      stations,
      (z) => {
        const t = (z + 2.15) / 4.3;
        const beam = half * (0.82 + 0.18 * Math.sin(Math.PI * t) ** 0.45);
        const end = Math.max(0, Math.abs(2 * t - 1) - 0.84) / 0.16;
        // Clears a 0.31 m wheel over each axle and drops to a sill between them.
        const floor = 0.26 + 0.42 * archLift(z, axles, 0.56) + end * 0.1;
        return slab(beam, floor, 1.0 - end * 0.11, 0.94);
      },
      paint
    ),
    loft([-1.86, 1.86], () => slab(0.6, 0.17, 0.42, 1), '#2b2f33')
  );

  // The greenhouse: glass all round, raked at both ends so the screens come out
  // of the sweep rather than being pasted on as flat plates.
  const cabin = [-0.82, -0.56, -0.1, 0.44, 0.78, 1.0];
  const cabinRoof = [1.12, 1.33, 1.44, 1.44, 1.26, 1.06];
  const cabinHalf = [0.68, 0.74, 0.77, 0.75, 0.69, 0.58];
  build.glass.push(loft(cabin, (_z, index) => slab(cabinHalf[index], 1.0, cabinRoof[index], 0.9), '#10181d'));
  build.body.push(loft([-0.52, 0.46], () => slab(0.78, 1.41, 1.48, 0.95), paint));

  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * 0.66, 1.0, 0.88], [side * 0.72, 1.44, 0.44], 0.045, paint, 5),
      strut([side * 0.76, 1.0, 0.06], [side * 0.78, 1.44, 0.06], 0.038, dark, 5),
      strut([side * 0.68, 1.0, -0.78], [side * 0.74, 1.44, -0.36], 0.05, paint, 5),
      strut([side * 0.74, 1.44, -0.4], [side * 0.74, 1.44, 0.46], 0.035, paint, 5),
      box([0.07, 0.09, 2.5], [side * (half - 0.04), 0.3, 0], '#2f3338'),
      box([0.13, 0.04, 0.035], [side * (half - 0.02), 0.92, 0.42], chrome),
      box([0.13, 0.04, 0.035], [side * (half - 0.02), 0.92, -0.36], chrome),
      strut([side * 0.8, 1.06, 0.74], [side * 0.97, 1.09, 0.7], 0.022, paint, 5),
      box([0.08, 0.12, 0.2], [side * 1.0, 1.1, 0.68], dark),
      box([0.02, 0.1, 0.17], [side * 1.03, 1.1, 0.68], '#9fb0b8')
    );

    for (const axle of axles) {
      const arch = new TorusGeometry(0.42, 0.05, 4, 10, Math.PI);
      arch.rotateY(Math.PI / 2);
      arch.translate(side * (half - 0.03), spec.wheelRadius, axle);
      build.body.push({ geometry: arch, color: paint });
    }
  }

  build.body.push(
    box([1.74, 0.24, 0.16], [0, 0.5, 2.11], '#44484c'),
    box([1.74, 0.24, 0.16], [0, 0.5, -2.11], '#44484c'),
    box([1.12, 0.22, 0.07], [0, 0.8, 2.13], dark),
    box([1.0, 0.035, 0.04], [0, 0.86, 2.16], chrome),
    box([1.0, 0.035, 0.04], [0, 0.79, 2.16], chrome),
    box([0.44, 0.13, 0.02], [0, 0.6, 2.17], '#e8e5da'),
    box([0.44, 0.13, 0.02], [0, 0.66, -2.17], '#e8e5da'),
    tube([0.035, 0.038], 0.12, [RIGHT * 0.52, 0.32, -2.12], '#7c8184', [Math.PI / 2, 0, 0], 8)
  );
  if (random() < 0.35) {
    // Half the cars on a Vietnamese road are carrying something on the roof.
    for (const side of [-1, 1]) build.body.push(box([0.05, 0.05, 1.0], [side * 0.6, 1.53, 0], '#55595d'));
    build.body.push(
      box([1.3, 0.05, 0.06], [0, 1.53, 0.44], '#55595d'),
      box([1.3, 0.05, 0.06], [0, 1.53, -0.44], '#55595d')
    );
  }

  for (const side of [-1, 1]) {
    build.head.push(box([0.36, 0.15, 0.06], [side * 0.58, 0.88, 2.12], '#ffffff'));
    build.body.push(box([0.14, 0.09, 0.05], [side * 0.8, 0.84, 2.12], '#e2a43c'));
    build.tail.push(box([0.28, 0.17, 0.05], [side * 0.62, 0.94, -2.12], '#ffffff'));
  }
  build.lamp = [0, 0.88, 2.2];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.21, -0.78, 6), ...wheel(spec.wheelRadius, 0.21, 0.78, 6));
  build.rearWheel.push(...wheel(spec.wheelRadius, 0.21, -0.78, 6), ...wheel(spec.wheelRadius, 0.21, 0.78, 6));
  return build;
};

// --- xe tải -------------------------------------------------------------------

const truckBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.truck;
  const dark = '#262a2e';
  const half = spec.width / 2;

  build.body.push(
    box([1.36, 0.18, 4.9], [0, 0.56, 0.1], '#3b3f43'),
    loft([1.02, 1.3, 2.3, 2.62], (z) => slab(half * (z > 2.4 ? 0.93 : 1), 0.7, z > 2.4 ? 1.86 : 2.2, 0.96), paint),
    box([half * 2, 0.5, 3.5], [0, 1.0, -0.78], paint),
    box([half * 1.96, 0.1, 3.5], [0, 1.26, -0.78], '#7b6246')
  );

  build.glass.push(
    box([half * 1.84, 0.78, 0.07], [0, 1.78, 2.56], '#10181d', [-0.13, 0, 0]),
    box([0.06, 0.6, 0.9], [-(half - 0.03), 1.66, 1.78], '#10181d'),
    box([0.06, 0.6, 0.9], [half - 0.03, 1.66, 1.78], '#10181d')
  );

  // Dropside boards with real corner stakes, which is what every small truck
  // here has and what a plain box body never looks like.
  for (const side of [-1, 1]) {
    build.body.push(
      box([0.08, 0.5, 3.5], [side * (half - 0.05), 1.56, -0.78], '#8a6f4e'),
      box([0.09, 0.56, 0.09], [side * (half - 0.05), 1.59, 0.9], '#5d4a35'),
      box([0.09, 0.56, 0.09], [side * (half - 0.05), 1.59, -2.46], '#5d4a35'),
      strut([side * (half + 0.02), 1.72, 2.44], [side * (half + 0.3), 1.72, 2.4], 0.025, dark, 5),
      box([0.08, 0.26, 0.17], [side * (half + 0.36), 1.68, 2.38], dark),
      box([0.02, 0.22, 0.14], [side * (half + 0.4), 1.68, 2.38], '#9fb0b8'),
      box([0.05, 0.42, 0.2], [side * (half - 0.04), 0.3, -1.68], '#1f2124')
    );
  }
  build.body.push(
    box([half * 1.9, 0.5, 0.08], [0, 1.56, -2.5], '#8a6f4e'),
    box([half * 2.02, 0.26, 0.18], [0, 0.48, 2.64], '#4a4e52'),
    box([1.2, 0.3, 0.08], [0, 0.95, 2.66], dark),
    box([0.46, 0.14, 0.02], [0, 0.62, 2.7], '#e8e5da')
  );

  // Sacks of rice, roped down. Stacked in two courses so the load has a shape.
  const sacks = 4 + Math.floor(random() * 4);
  for (let s = 0; s < sacks; s += 1) {
    const sack = new SphereGeometry(0.3, 8, 6);
    sack.scale(1.1, 0.74, 1.3);
    sack.rotateY(random() * Math.PI);
    sack.translate((random() - 0.5) * 1.1, 1.52 + Math.floor(s / 4) * 0.4, -0.3 - (s % 4) * 0.62);
    build.body.push({ geometry: sack, color: s % 3 === 0 ? '#cdc3a4' : '#b8ad8c' });
  }
  for (const side of [-1, 1]) {
    build.body.push(
      strut([side * (half - 0.06), 1.58, 0.7], [side * (half - 0.06) * 0.2, 2.0, -0.8], 0.014, '#4a4335', 4)
    );
  }

  for (const side of [-1, 1]) {
    build.head.push(box([0.3, 0.16, 0.06], [side * 0.62, 0.92, 2.68], '#ffffff'));
    build.tail.push(box([0.22, 0.2, 0.05], [side * 0.68, 0.78, -2.58], '#ffffff'));
  }
  build.lamp = [0, 0.92, 2.74];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.22, -0.8, 6), ...wheel(spec.wheelRadius, 0.22, 0.8, 6));
  // Twin rears, the giveaway that it is a load-carrier and not just a big car.
  for (const side of [-1, 1]) {
    build.rearWheel.push(
      ...wheel(spec.wheelRadius, 0.2, side * 0.66, 6),
      ...wheel(spec.wheelRadius, 0.2, side * 0.88, 6)
    );
  }
  return build;
};

// --- xe khách -----------------------------------------------------------------

const coachBuild = (paint: string, trim: string): Build => {
  const build = emptyBuild();
  const spec = SPECS.coach;
  const half = spec.width / 2;
  const dark = '#23262a';
  const axles = [spec.frontAxle, spec.rearAxle];

  const stations: number[] = [];
  for (let i = 0; i <= 28; i += 1) stations.push(-5.25 + (i / 28) * 10.5);

  build.body.push(
    loft(
      stations,
      (z) => {
        const t = (z + 5.25) / 10.5;
        const end = Math.max(0, Math.abs(2 * t - 1) - 0.9) / 0.1;
        const floor = 0.5 + 0.66 * archLift(z, axles, 0.9) + end * 0.14;
        return slab(half * (1 - end * 0.09), floor, 3.34 - end * 0.22, 0.93);
      },
      paint
    ),
    box([half * 2.02, 0.42, 9.6], [0, 1.6, -0.3], trim),
    box([half * 2.04, 0.14, 10.2], [0, 1.1, -0.2], trim)
  );

  build.glass.push(
    loft([-4.6, 4.3], () => slab(half - 0.04, 1.9, 2.82, 0.96), '#121b20'),
    box([half * 1.82, 1.12, 0.1], [0, 2.3, 5.14], '#121b20', [-0.1, 0, 0]),
    box([half * 1.8, 0.95, 0.09], [0, 2.26, -5.14], '#121b20', [0.08, 0, 0])
  );
  for (let p = -4; p <= 4; p += 1) {
    build.body.push(box([half * 2.06, 0.95, 0.09], [0, 2.36, p * 1.06], paint));
  }

  build.body.push(
    box([1.7, 0.3, 0.06], [0, 3.02, 5.1], dark),
    box([1.5, 0.19, 0.03], [0, 3.02, 5.14], '#d9cf9a'),
    box([half * 1.9, 0.1, 9.0], [0, 3.4, -0.3], trim),
    box([0.9, 0.72, 0.07], [RIGHT * (half - 0.01), 1.3, 2.0], dark),
    box([0.9, 0.72, 0.07], [RIGHT * (half - 0.01), 1.3, -1.6], dark),
    box([half * 2.02, 0.3, 0.2], [0, 0.72, 5.2], '#4a4e52'),
    box([half * 2.02, 0.3, 0.2], [0, 0.72, -5.2], '#4a4e52'),
    box([0.48, 0.14, 0.02], [0, 0.84, 5.28], '#e8e5da'),
    box([0.1, 1.8, 0.95], [RIGHT * (half - 0.02), 1.6, 3.6], dark)
  );
  build.glass.push(box([0.06, 1.1, 0.8], [RIGHT * (half - 0.06), 2.0, 3.6], '#121b20'));

  for (const side of [-1, 1]) {
    build.head.push(
      box([0.3, 0.17, 0.06], [side * 0.86, 1.08, 5.24], '#ffffff'),
      box([0.2, 0.13, 0.05], [side * 1.06, 0.86, 5.24], '#ffffff')
    );
    build.tail.push(
      box([0.24, 0.2, 0.05], [side * 0.88, 1.1, -5.24], '#ffffff'),
      box([0.18, 0.14, 0.05], [side * 1.04, 0.86, -5.24], '#ffffff')
    );
    // Roof marker lamps: how you see one of these coming round a bend at night.
    for (let m = -1; m <= 1; m += 1) build.tail.push(box([0.1, 0.06, 0.1], [side * 1.0, 3.3, m * 2.4], '#ffffff'));
    build.body.push(
      strut([side * (half + 0.02), 2.6, 4.95], [side * (half + 0.34), 2.6, 4.88], 0.028, dark, 5),
      box([0.09, 0.32, 0.2], [side * (half + 0.42), 2.54, 4.86], dark)
    );
  }
  build.lamp = [0, 1.08, 5.32];

  build.frontWheel.push(...wheel(spec.wheelRadius, 0.26, -1.06, 8), ...wheel(spec.wheelRadius, 0.26, 1.06, 8));
  for (const side of [-1, 1]) {
    build.rearWheel.push(
      ...wheel(spec.wheelRadius, 0.24, side * 0.9, 8),
      ...wheel(spec.wheelRadius, 0.24, side * 1.16, 8)
    );
  }

  // Left-hand drive, because the traffic keeps right.
  build.rider.push(
    ...seatedRider(
      [-RIGHT * 0.72, 1.72, 4.1],
      [-RIGHT * 0.72, 1.84, 4.52],
      [-RIGHT * 0.72, 1.24, 4.6],
      { shirt: '#d8d3c4', trousers: '#2f3440', skin: SKIN[0], hat: 'cap', helmet: '#2d3136' },
      0.1,
      { grip: 0.2, foot: 0.14 }
    )
  );
  return build;
};

// --- xe đạp -------------------------------------------------------------------

const bicycleBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.bicycle;
  const r = spec.wheelRadius;
  const axle = spec.frontAxle;
  const bb: [number, number, number] = [0, 0.29, -0.06];
  const seatTop: [number, number, number] = [0, 0.96, -0.28];
  const headTop: [number, number, number] = [0, 0.96, axle - 0.08];

  build.body.push(
    strut(bb, seatTop, 0.019, paint, 5),
    strut(bb, headTop, 0.021, paint, 5),
    strut(seatTop, headTop, 0.018, paint, 5),
    strut(bb, [0, r, spec.rearAxle], 0.015, paint, 5),
    strut(seatTop, [0, r, spec.rearAxle], 0.013, paint, 5),
    box([0.17, 0.05, 0.26], [0, 0.99, -0.3], '#2a2b2e'),
    tube([0.095, 0.095], 0.012, [0, 0.29, -0.02], '#9fa4a7', [0, 0, Math.PI / 2], 16),
    box([0.1, 0.04, 0.06], [0, 0.76, -0.42], '#9fa4a7'),
    tube([0.16, 0.13], 0.22, [0, 0.76, axle + 0.08], '#b39a6e', undefined, 12),
    tube([0.165, 0.165], 0.022, [0, 0.87, axle + 0.08], '#8d7a55', undefined, 12)
  );
  if (random() < 0.6) {
    const bundle = new SphereGeometry(0.15, 8, 6);
    bundle.scale(1.1, 0.8, 1);
    bundle.translate(0, 0.91, axle + 0.08);
    build.body.push({ geometry: bundle, color: '#5f7a44' });
  }

  build.steer.push(
    strut([0, 0.98, axle - 0.08], [0, r, axle], 0.018, paint, 5),
    tube([0.013, 0.013], 0.5, [0, 1.02, axle - 0.1], '#9fa4a7', [0, 0, Math.PI / 2], 6)
  );
  for (const side of [-1, 1]) {
    build.steer.push(tube([0.019, 0.019], 0.11, [side * 0.2, 1.02, axle - 0.1], '#2a2b2e', [0, 0, Math.PI / 2], 6));
  }

  build.frontWheel.push(...wheel(r, 0.05, 0, 9, '#c6cbce'));
  build.rearWheel.push(...wheel(r, 0.05, 0, 9, '#c6cbce'));
  // No headlight. Half of them have none, and the rear reflector is the only
  // thing that lights up — which is itself the honest night-time silhouette.
  build.tail.push(box([0.07, 0.05, 0.02], [0, 0.72, -0.44], '#ffffff'));

  build.rider.push(
    ...seatedRider(
      [0, 1.03, -0.3],
      [0, 1.04, axle - 0.08],
      [0, 0.34, 0.0],
      dress(random, random() < 0.5 ? 'non-la' : 'cap'),
      0.18,
      {
        grip: 0.2,
        foot: 0.15,
      }
    )
  );
  for (const side of [-1, 1]) {
    build.swing.push({
      parts: [
        box([0.03, 0.17, 0.03], [0, -0.085, 0], '#8e9397'),
        box([0.075, 0.03, 0.12], [side * 0.05, -0.17, 0], '#2a2b2e'),
      ],
      at: [side * 0.08, bb[1], bb[2]],
      phase: side > 0 ? 0 : Math.PI,
      gain: 1,
    });
  }
  return build;
};

// --- xích lô ------------------------------------------------------------------

const cycloBuild = (paint: string, random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS.cyclo;
  const r = spec.wheelRadius;
  const frame = '#4d5a63';

  build.body.push(
    box([1.1, 0.07, 0.9], [0, 0.42, 0.82], '#6b5842'),
    box([1.0, 0.5, 0.08], [0, 0.72, 0.42], paint),
    box([1.02, 0.12, 0.08], [0, 1.0, 0.44], '#3a3024'),
    box([0.07, 0.4, 0.84], [-0.52, 0.66, 0.82], paint),
    box([0.07, 0.4, 0.84], [0.52, 0.66, 0.82], paint),
    box([0.96, 0.05, 0.3], [0, 0.3, 1.28], '#6b5842'),
    strut([-0.5, 0.38, 0.4], [0, 0.46, -0.5], 0.028, frame, 5),
    strut([0.5, 0.38, 0.4], [0, 0.46, -0.5], 0.028, frame, 5),
    strut([-0.52, r, 0.95], [0.52, r, 0.95], 0.022, frame, 5),
    strut([0, 0.46, -0.5], [0, 0.3, -1.02], 0.024, frame, 5),
    strut([0, 1.04, -0.56], [0, 0.34, -0.3], 0.02, frame, 5),
    box([0.16, 0.05, 0.24], [0, 1.08, -0.58], '#2a2b2e'),
    tube([0.014, 0.014], 0.44, [0, 1.12, -0.18], '#9fa4a7', [0, 0, Math.PI / 2], 6),
    tube([0.09, 0.09], 0.01, [0, 0.34, -0.3], '#9fa4a7', [0, 0, Math.PI / 2], 14)
  );

  // The folding hood over the passenger, which is what a xích lô is known by.
  for (let rib = 0; rib < 3; rib += 1) {
    const hood = new TorusGeometry(0.56, 0.028, 4, 10, Math.PI);
    hood.rotateY(Math.PI / 2);
    hood.translate(0, 0.98, 1.0 + rib * 0.24);
    build.body.push({ geometry: hood, color: frame });
  }
  build.body.push(
    loft(
      [0.98, 1.22, 1.5],
      () => [
        [-0.58, 0.98],
        [-0.42, 1.44],
        [0.42, 1.44],
        [0.58, 0.98],
      ],
      '#2f4858'
    )
  );

  build.frontWheel.push(...wheel(r, 0.05, -0.52, 9, '#c6cbce'), ...wheel(r, 0.05, 0.52, 9, '#c6cbce'));
  build.rearWheel.push(...wheel(r + 0.01, 0.05, 0, 9, '#c6cbce'));
  build.tail.push(box([0.07, 0.05, 0.02], [0, 0.4, -1.16], '#ffffff'));

  build.rider.push(
    ...seatedRider([0, 1.12, -0.54], [0, 1.12, -0.2], [0, 0.46, -0.3], dress(random, 'non-la'), 0.2, {
      grip: 0.18,
      foot: 0.14,
    })
  );
  if (random() < 0.7) {
    build.rider.push(
      ...seatedRider([0, 0.62, 0.74], [0, 0.66, 1.0], [0, 0.34, 1.24], dress(random, 'none'), -0.05, {
        grip: 0.22,
        foot: 0.17,
      })
    );
  }
  for (const side of [-1, 1]) {
    build.swing.push({
      parts: [
        box([0.03, 0.16, 0.03], [0, -0.08, 0], '#8e9397'),
        box([0.07, 0.03, 0.11], [side * 0.05, -0.16, 0], '#2a2b2e'),
      ],
      at: [side * 0.08, 0.34, -0.3],
      phase: side > 0 ? 0 : Math.PI,
      gain: 1,
    });
  }
  return build;
};

// --- xe trâu ------------------------------------------------------------------

const buffaloCartBuild = (random: () => number): Build => {
  const build = emptyBuild();
  const spec = SPECS['buffalo-cart'];
  const wood = '#7b6246';
  const hide = '#4a4540';

  build.body.push(
    box([1.34, 0.1, 2.1], [0, 0.78, -0.3], wood),
    box([1.4, 0.12, 0.14], [0, 0.72, -1.28], '#5d4a35'),
    box([1.4, 0.12, 0.14], [0, 0.72, 0.66], '#5d4a35'),
    box([0.12, 0.44, 2.1], [-0.65, 1.04, -0.3], '#8a6f4e'),
    box([0.12, 0.44, 2.1], [0.65, 1.04, -0.3], '#8a6f4e'),
    box([1.34, 0.44, 0.1], [0, 1.04, -1.33], '#8a6f4e'),
    box([0.16, 0.16, 0.5], [0, 0.72, -0.3], '#5d4a35'),
    strut([-0.5, 0.74, 0.6], [-0.42, 0.92, 2.42], 0.045, wood, 6),
    strut([0.5, 0.74, 0.6], [0.42, 0.92, 2.42], 0.045, wood, 6),
    box([1.16, 0.1, 0.12], [0, 0.95, 2.44], '#5d4a35')
  );

  for (const side of [-1, 1]) build.rearWheel.push(...cartWheel(spec.wheelRadius, side * 0.78));

  const bales = 3 + Math.floor(random() * 3);
  for (let b = 0; b < bales; b += 1) {
    build.body.push(
      tube(
        [0.26, 0.26],
        1.1,
        [(random() - 0.5) * 0.5, 1.12 + Math.floor(b / 2) * 0.46, -0.3 - (b % 2) * 0.6],
        '#c9b574',
        [0, (random() - 0.5) * 0.2, Math.PI / 2],
        9
      )
    );
  }

  // --- con trâu -------------------------------------------------------------
  const barrel = new SphereGeometry(0.52, 12, 9);
  barrel.scale(0.92, 0.9, 1.5);
  barrel.translate(0, 1.0, 3.5);
  build.body.push({ geometry: barrel, color: hide });
  build.body.push(
    box([0.78, 0.5, 0.5], [0, 1.26, 3.0], hide),
    strut([0, 1.1, 4.3], [0, 0.92, 4.86], 0.2, hide, 7),
    box([0.3, 0.24, 0.26], [0, 0.86, 5.0], '#3a3631'),
    box([0.2, 0.08, 0.1], [0, 0.78, 5.12], '#262320'),
    strut([0, 1.18, 2.98], [0, 1.02, 2.3], 0.035, hide, 5),
    box([1.1, 0.1, 0.14], [0, 1.44, 3.3], '#6b5339')
  );
  for (const side of [-1, 1]) {
    const horn = new TorusGeometry(0.26, 0.035, 4, 9, Math.PI * 0.8);
    horn.rotateX(Math.PI / 2);
    horn.rotateZ(side * 0.5);
    horn.translate(side * 0.16, 1.1, 4.82);
    build.body.push(
      { geometry: horn, color: '#b8ae96' },
      box([0.1, 0.18, 0.06], [side * 0.26, 1.0, 4.76], hide),
      strut([side * 0.44, 1.44, 3.3], [side * 0.42, 0.98, 2.5], 0.022, '#4a4335', 4)
    );
  }

  for (const side of [-1, 1]) {
    for (const along of [3.02, 4.0]) {
      build.swing.push({
        parts: [strut([0, 0, 0], [0, -0.78, 0.04], 0.07, hide, 6), box([0.14, 0.09, 0.2], [0, -0.82, 0.08], '#2b2823')],
        at: [side * 0.3, 0.98, along],
        phase: (side > 0 ? 0 : Math.PI) + (along > 3.5 ? Math.PI : 0),
        gain: 0.26,
      });
    }
  }

  build.rider.push(
    ...seatedRider(
      [-RIGHT * 0.3, 0.98, 0.4],
      [-RIGHT * 0.3, 1.04, 0.86],
      [-RIGHT * 0.3, 0.5, 0.78],
      { shirt: '#8a7f66', trousers: '#4a4237', skin: SKIN[2], hat: 'non-la', helmet: '#3b4149' },
      0.12,
      { grip: 0.18, foot: 0.15 }
    )
  );
  return build;
};

/**
 * One machine of this kind, painted out of the given sequence.
 *
 * Lifted out of `createVehicles`, where it was a closure over the fleet's own
 * prng. It had to come out: `avatar-ride.ts` needs a xe máy and there was no way
 * to ask for one, because the only function that could build a `Build` was
 * inside the function that owned the whole fleet.
 */
export const buildFor = (kind: VehicleKind, random: () => number): Build => {
  const paint = pick(PAINT, random);
  switch (kind) {
    case 'motorbike':
      return motorbikeBuild(paint, false, random);
    case 'motorbike-cargo':
      return motorbikeBuild(paint, true, random);
    case 'car':
      return carBuild(paint, random);
    case 'truck':
      return truckBuild(paint, random);
    case 'coach':
      return coachBuild(paint, pick(PAINT, random));
    case 'bicycle':
      return bicycleBuild(paint, random);
    case 'cyclo':
      return cycloBuild(paint, random);
    default:
      return buffaloCartBuild(random);
  }
};
