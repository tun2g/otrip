/**
 * The primitives every vehicle is made of: a lofted shell, a wheel, a cart
 * wheel, and a seated figure.
 *
 * Split off `vehicles.ts` along the seam the file already had a comment for.
 * Nothing here knows what a motorbike is — a station list, a radius and a pair
 * of hands to reach are the whole interface — which is why one `seatedRider`
 * rigs a rider to handlebars, a cyclo driver to his pedals and a carter to his
 * reins, and why the arch over an axle is a bulge in a sweep rather than a hole
 * cut in a body.
 */
import { BufferAttribute, BufferGeometry, ConeGeometry, SphereGeometry, TorusGeometry } from 'three';

import { box, strut, tube, type Part } from './road-network';

/**
 * Local +Z is the way a vehicle faces and local +Y is up, which in a
 * right-handed frame puts the driver's right hand on local **−X**. Vietnam
 * drives on the right, so the kerb, the exhaust, the coach door and the lane
 * offset all live on that side; getting the sign wrong puts the whole fleet in
 * the oncoming lane.
 */
export const RIGHT = -1;

export const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Sweeps a closed cross-section along Z and caps both ends. One call is a whole
 * shell: the silhouette comes out of the station functions rather than out of a
 * stack of boxes, which is the difference between a car and a crate.
 */
export const loft = (
  stations: number[],
  ring: (z: number, index: number) => [number, number][],
  color: string
): Part => {
  const positions: number[] = [];
  const indices: number[] = [];
  const rings = stations.map((z, index) => ring(z, index));
  const points = rings[0].length;

  rings.forEach((entries, index) => {
    for (const point of entries) positions.push(point[0], point[1], stations[index]);
  });

  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = i * points;
    const b = a + points;
    for (let p = 0; p < points; p += 1) {
      const next = (p + 1) % points;
      indices.push(a + p, a + next, b + next, a + p, b + next, b + p);
    }
  }

  for (let p = 1; p + 1 < points; p += 1) indices.push(0, p + 1, p);
  const tail = (rings.length - 1) * points;
  for (let p = 1; p + 1 < points; p += 1) indices.push(tail, tail + p, tail + p + 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, color };
};

/** A rounded-rectangle section, bottom-left round to top-left. `taper` narrows the roof. */
export const slab = (half: number, floor: number, roof: number, taper: number): [number, number][] => {
  const lift = Math.min(0.2, (roof - floor) * 0.24);
  const top = half * taper;
  return [
    [-half, floor + lift],
    [-half * 0.74, floor],
    [half * 0.74, floor],
    [half, floor + lift],
    [half, roof - lift],
    [top * 0.88, roof],
    [-top * 0.88, roof],
    [-half, roof - lift],
  ];
};

/**
 * How much the body's underside has to rise at this station to clear a wheel.
 * A low-poly body cannot have a hole cut in it, so the arch is built into the
 * sweep instead — and that bulge over each axle is most of what makes a body
 * shell read as a car rather than a shoebox.
 */
export const archLift = (z: number, axles: number[], reach: number) => {
  let most = 0;
  for (const axle of axles) most = Math.max(most, 1 - smoothstep(reach * 0.55, reach, Math.abs(z - axle)));
  return most;
};

/**
 * One wheel at an offset along the axle. The tyre is a torus rather than a disc
 * because the profile is the first thing the eye checks on a wheel, and the
 * spokes are what make it obviously turning rather than sliding.
 */
export const wheel = (radius: number, width: number, offset: number, spokes: number, rim = '#9a9ea1'): Part[] => {
  const parts: Part[] = [];
  const section = width * 0.36;

  const tyre = new TorusGeometry(radius - section, section, 6, 16);
  tyre.rotateY(Math.PI / 2);
  tyre.translate(offset, 0, 0);
  parts.push({ geometry: tyre, color: '#1b1b1d' });

  parts.push(
    tube([radius - section * 1.7, radius - section * 1.7], width * 0.42, [offset, 0, 0], rim, [0, 0, Math.PI / 2], 14)
  );
  parts.push(tube([width * 0.34, width * 0.34], width * 1.16, [offset, 0, 0], '#6e7275', [0, 0, Math.PI / 2], 8));

  for (let s = 0; s < spokes; s += 1) {
    const spoke = box([width * 0.16, (radius - section * 1.8) * 2, width * 0.1], [offset, 0, 0], rim);
    spoke.geometry.rotateX((s / spokes) * Math.PI);
    parts.push(spoke);
  }
  return parts;
};

/** A wooden cart wheel: a broad felloe, a thick hub and six real spokes. */
export const cartWheel = (radius: number, offset: number): Part[] => {
  const parts: Part[] = [];
  const felloe = new TorusGeometry(radius - 0.05, 0.05, 5, 18);
  felloe.rotateY(Math.PI / 2);
  felloe.translate(offset, 0, 0);
  parts.push({ geometry: felloe, color: '#6b5339' });
  parts.push(tube([0.1, 0.1], 0.2, [offset, 0, 0], '#4e3d2b', [0, 0, Math.PI / 2], 10));
  for (let s = 0; s < 6; s += 1) {
    const spoke = box([0.055, (radius - 0.06) * 2, 0.055], [offset, 0, 0], '#755c40');
    spoke.geometry.rotateX((s / 6) * Math.PI);
    parts.push(spoke);
  }
  return parts;
};

export type Outfit = {
  shirt: string;
  trousers: string;
  skin: string;
  /** Mũ bảo hiểm, nón lá, a cloth cap, or bare-headed. */
  hat: 'helmet' | 'non-la' | 'cap' | 'none';
  helmet: string;
};

export const SKIN = ['#b88f68', '#c49a72', '#a87f5c'];
const SHIRTS = ['#4c5f72', '#8a4238', '#d8d3c4', '#3f6049', '#6f5a7d', '#2f4858'];
const TROUSERS = ['#2f3440', '#4a4237', '#36414a', '#5c5247'];
const HELMETS = ['#d9d4c6', '#2d3136', '#b03a2e', '#2f6b82'];

export const pick = <T>(list: T[], random: () => number): T => list[Math.floor(random() * list.length)];

export const dress = (random: () => number, hat: Outfit['hat']): Outfit => ({
  shirt: pick(SHIRTS, random),
  trousers: pick(TROUSERS, random),
  skin: pick(SKIN, random),
  hat,
  helmet: pick(HELMETS, random),
});

/**
 * A seated figure, built as one merged mesh. Nobody gets close enough to a
 * passing bike for an articulated spine to matter, and the lean that actually
 * sells it belongs to the machine the figure is sitting on. Arms reach `hands`
 * and legs reach `feet`, so the same function rigs a rider to handlebars, a
 * cyclo driver to his pedals and a carter to his reins.
 */
export const seatedRider = (
  hip: [number, number, number],
  hands: [number, number, number],
  feet: [number, number, number],
  outfit: Outfit,
  lean: number,
  spread: { grip: number; foot: number }
): Part[] => {
  const parts: Part[] = [];
  const shoulderY = hip[1] + 0.5;
  const shoulderZ = hip[2] + Math.sin(lean) * 0.46;

  parts.push(box([0.34, 0.2, 0.3], hip, outfit.trousers));
  parts.push(
    box([0.36, 0.56, 0.24], [hip[0], (hip[1] + shoulderY) / 2 + 0.05, (hip[2] + shoulderZ) / 2], outfit.shirt, [
      -lean,
      0,
      0,
    ])
  );
  parts.push(box([0.42, 0.15, 0.23], [hip[0], shoulderY, shoulderZ], outfit.shirt, [-lean, 0, 0]));
  parts.push(tube([0.055, 0.062], 0.09, [hip[0], shoulderY + 0.1, shoulderZ + 0.02], outfit.skin, undefined, 6));

  const headY = shoulderY + 0.24;
  const headZ = shoulderZ + 0.04;
  const head = new SphereGeometry(0.1, 9, 7);
  head.scale(1, 1.14, 1.04);
  head.translate(hip[0], headY, headZ);
  parts.push({ geometry: head, color: outfit.skin });

  if (outfit.hat === 'helmet') {
    const shell = new SphereGeometry(0.135, 11, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
    shell.translate(hip[0], headY + 0.015, headZ);
    parts.push({ geometry: shell, color: outfit.helmet });
    // The peak and the dark visor band are what make a helmet read as a helmet
    // from behind, which is the angle anyone following a bike actually has.
    parts.push(box([0.2, 0.03, 0.1], [hip[0], headY + 0.04, headZ + 0.13], outfit.helmet, [0.2, 0, 0]));
    parts.push(box([0.21, 0.07, 0.03], [hip[0], headY - 0.01, headZ + 0.11], '#2a3036'));
  } else if (outfit.hat === 'non-la') {
    const cone = new ConeGeometry(0.29, 0.16, 14);
    cone.translate(hip[0], headY + 0.12, headZ);
    parts.push({ geometry: cone, color: '#d9c48c' });
  } else if (outfit.hat === 'cap') {
    parts.push(box([0.21, 0.07, 0.21], [hip[0], headY + 0.1, headZ], outfit.helmet));
    parts.push(box([0.19, 0.02, 0.1], [hip[0], headY + 0.08, headZ + 0.14], outfit.helmet));
  }

  for (const side of [-1, 1]) {
    const shoulder: [number, number, number] = [hip[0] + side * 0.2, shoulderY - 0.02, shoulderZ];
    const grip: [number, number, number] = [hands[0] + side * spread.grip, hands[1], hands[2]];
    const elbow: [number, number, number] = [
      (shoulder[0] + grip[0]) / 2 + side * 0.07,
      (shoulder[1] + grip[1]) / 2 - 0.08,
      (shoulder[2] + grip[2]) / 2 - 0.02,
    ];
    parts.push(strut(shoulder, elbow, 0.048, outfit.shirt, 5), strut(elbow, grip, 0.042, outfit.skin, 5));

    const hipAt: [number, number, number] = [hip[0] + side * 0.12, hip[1] - 0.04, hip[2]];
    const foot: [number, number, number] = [feet[0] + side * spread.foot, feet[1], feet[2]];
    const knee: [number, number, number] = [
      (hipAt[0] + foot[0]) / 2 + side * 0.04,
      (hipAt[1] + foot[1]) / 2 + 0.07,
      (hipAt[2] + foot[2]) / 2 + 0.16,
    ];
    parts.push(strut(hipAt, knee, 0.064, outfit.trousers, 5), strut(knee, foot, 0.053, outfit.trousers, 5));
    parts.push(box([0.09, 0.05, 0.22], [foot[0], foot[1] - 0.01, foot[2] + 0.04], '#2b2b2e'));
  }

  return parts;
};
