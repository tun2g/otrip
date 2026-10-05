import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type BufferGeometry as Geometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const LENGTH = 14.5;
const BEAM = 3.8;
/**
 * Moulded depth, keel to gunwale amidships. It was 1.7, which at the waterline
 * below leaves 1.53 m of freeboard and sinks the floorboards into a 1.29 m well:
 * the boatman's whole figure disappeared under the rail and so did anyone
 * standing aboard. 1.25 gives 1.07 m of freeboard and 0.83 m from the sole to
 * the gunwale, which is hip height on a standing man.
 */
const DEPTH = 1.25;
/**
 * Designed draught: how deep the keel sits amidships with her afloat. Measured
 * off this hull's own sections it puts 3.3 tonnes in the water — a 14.5 m timber
 * hull with her canopy, her boatman and a few hundred kilos of cargo.
 *
 * The group origin used to be put on the waterline itself, which floated her on
 * 1.70 m of draught and 44.8 tonnes of displacement. The river then ran 1.52 m
 * above the floorboards and the water plane was drawn straight through the
 * inside of the boat: that is what "trong thuyền có nước" was.
 */
const DRAUGHT = 0.35;

/** Half-beam, deck line and keel line as functions of position along the hull. */
const halfBeamAt = (t: number) => Math.sin(Math.PI * t) ** 0.6 * (BEAM / 2);
const keelAt = (t: number) => -DEPTH * (1 - (2 * t - 1) ** 2 * 0.52);
const sheerAt = (t: number) => DEPTH * 0.34 * (0.4 + (2 * t - 1) ** 2 * 0.6);

/** The still waterline, in the boat's own frame. */
const WATERLINE = keelAt(0.5) + DRAUGHT;
/**
 * Top of the floorboards. Clear of the waterline by more than everything that
 * moves the hull put together — heave, roll, the pitch she trims to under way,
 * and the roll the stroke itself puts in. Measured by walking every point of the
 * lofted sole through sixty-six seconds of `update` at full way: the lowest any
 * of them gets is 0.156 m above the water. At 0.24 m it was 3 cm, which is not a
 * margin. This still leaves 0.75 m from the sole to the gunwale.
 */
const SOLE = WATERLINE + 0.32;
/** A thwart is something you can sit on, which is this far above the sole. */
const THWART = SOLE + 0.42;

/** The station the boatman and his tholepin share, aft of amidships. */
const OAR_T = 0.24;
/**
 * How far outboard the oar leans. Solved rather than picked: the blade's centre
 * is 2.0 m down the shaft, the tholepin stands 1.14 m above the water, and
 * acos(1.198 / 2.0) puts the blade 0.06 m under the surface — deep enough to
 * bite, shallow enough that the stroke's own 0.07 m of lift brings it out.
 */
const OAR_LEAN = 0.93;

/** Six points per section, from the gunwale down to the keel. */
const RING = [
  { width: 1, height: 1 },
  { width: 0.93, height: 0.42 },
  { width: 0.72, height: 0.04 },
  { width: 0.38, height: -0.22 },
  { width: 0, height: -0.32 },
];

const ringHeight = (t: number, height: number) => {
  const keel = keelAt(t);
  return keel + (sheerAt(t) - keel) * (height + 0.32) * 0.757;
};

/**
 * Half-width of the hull at a station and a height, read off the same ring the
 * planking is lofted from. Everything that lies inside the boat is sized by it,
 * so nothing has to guess at a fraction of the beam and come out through the
 * side.
 */
const sectionHalfWidth = (t: number, y: number): number => {
  const half = halfBeamAt(t);
  let lowY = ringHeight(t, RING[RING.length - 1].height);
  let lowW = half * RING[RING.length - 1].width;
  if (y <= lowY) return 0;
  for (let p = RING.length - 2; p >= 0; p -= 1) {
    const highY = ringHeight(t, RING[p].height);
    const highW = half * RING[p].width;
    if (y <= highY) return lowW + (highW - lowW) * ((y - lowY) / (highY - lowY));
    lowY = highY;
    lowW = highW;
  }
  return lowW;
};

/**
 * The hull, lofted from cross sections. Six points per section round the bilge
 * off, which is the difference between a boat and a trough — the join between
 * the side and the bottom is the first thing the eye checks.
 */
const createHullGeometry = (): BufferGeometry => {
  const sections = 30;

  const positions: number[] = [];
  const indices: number[] = [];
  const perSection = RING.length * 2 - 1;

  for (let i = 0; i <= sections; i += 1) {
    const t = i / sections;
    const z = (t - 0.5) * LENGTH;
    const halfBeam = halfBeamAt(t);

    // Port side down to the keel, then back up the starboard side.
    for (let p = RING.length - 1; p >= 0; p -= 1) {
      positions.push(-halfBeam * RING[p].width, ringHeight(t, RING[p].height), z);
    }
    for (let p = 1; p < RING.length; p += 1) {
      positions.push(halfBeam * RING[p].width, ringHeight(t, RING[p].height), z);
    }
  }

  for (let i = 0; i < sections; i += 1) {
    for (let p = 0; p < perSection - 1; p += 1) {
      const a = i * perSection + p;
      const b = (i + 1) * perSection + p;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * The floorboards, lofted to the sections they lie on. A rectangular board came
 * out through the planking near the ends, where the hull is barely 0.76 m across
 * at this height against the 0.80 m the board claimed — and below the bottom
 * entirely at the quarters, because the old sole sat 1.52 m under the water and
 * the hull's rockered ends do not go that deep. Inset 8 cm, which leaves the
 * limber gap along the bilge that a real sole has.
 */
const createSoleGeometry = (): BufferGeometry => {
  const sections = 16;
  const from = 0.17;
  const to = 0.83;

  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= sections; i += 1) {
    const t = from + (i / sections) * (to - from);
    const half = Math.max(0.06, sectionHalfWidth(t, SOLE) - 0.08);
    const z = (t - 0.5) * LENGTH;
    positions.push(-half, SOLE, z, half, SOLE, z);
  }
  for (let i = 0; i < sections; i += 1) {
    const a = i * 2;
    const b = (i + 1) * 2;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/**
 * A frame, lying against the planking at one station. The old one was a
 * half-torus: an arch that crossed the boat 0.8 m up in clear air, which is not
 * where a frame is and not what one looks like. This follows the same section the
 * planking is lofted from, gunwale to garboard to gunwale, so it reads as timber
 * bent to the hull.
 */
const createFrameGeometry = (t: number): BufferGeometry => {
  const half = halfBeamAt(t);
  const z = (t - 0.5) * LENGTH;
  const points: Vector3[] = [];
  for (let p = 0; p < RING.length; p += 1) {
    points.push(new Vector3(-half * RING[p].width * 0.97, ringHeight(t, RING[p].height) + 0.03, z));
  }
  for (let p = RING.length - 2; p >= 0; p -= 1) {
    points.push(new Vector3(half * RING[p].width * 0.97, ringHeight(t, RING[p].height) + 0.03, z));
  }
  return new TubeGeometry(new CatmullRomCurve3(points), 20, 0.05, 5, false);
};

/** A rail or strake running the length of one side, at a fraction of the depth. */
const createStrakeGeometry = (side: number, drop: number, radius: number): BufferGeometry => {
  const points: Vector3[] = [];
  for (let i = 0; i <= 14; i += 1) {
    const t = i / 14;
    const sheer = sheerAt(t);
    const keel = keelAt(t);
    points.push(
      new Vector3(side * halfBeamAt(t) * (1 - drop * 0.22), sheer - (sheer - keel) * drop, (t - 0.5) * LENGTH)
    );
  }
  return new TubeGeometry(new CatmullRomCurve3(points), 26, radius, 5, false);
};

const WOOD_SHADES = ['#6f5742', '#7d6246', '#5e4a38', '#86694a'];

type BoatPart = { geometry: Geometry; material: Material; matrix?: Matrix4 };

/** A part's placement as a matrix, so it can be baked into the merged buffer. */
const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): Matrix4 =>
  new Matrix4().makeScale(sx, sy, sz).setPosition(x, y, z);

const bake = (part: BoatPart): Geometry => {
  const geometry = part.geometry.clone();
  if (part.matrix) geometry.applyMatrix4(part.matrix);
  // The lofted hull carries no uvs and every primitive does. mergeGeometries
  // refuses the mismatch outright, and nothing on a boat samples a texture.
  geometry.deleteAttribute('uv');
  return geometry;
};

export type Boat = {
  group: Group;
  /**
   * Advances the rowing stroke and the hull's motion in the water. `way` is how
   * hard she is being driven, 0 lying still to 1 flat out: the stroke rate and
   * the hull's answer to it both climb with it, which is the only thing on screen
   * that tells you the helm is doing anything.
   */
  update: (elapsed: number, way?: number) => void;
  /**
   * Whether she is making way. The foam astern is twenty-two metres long, so on
   * a boat lying at the jetty it is a wake trailing off a hull that has not
   * moved — the one thing that gives a moored boat away.
   */
  setUnderway: (making: boolean) => void;
  setNight: (amount: number) => void;
  dispose: () => void;
};

export type BoatKit = {
  /** Builds one boat. Variant picks its wood, cargo and whether it is covered. */
  create: (variant: number) => Boat;
  dispose: () => void;
};

/**
 * Thuyền. There are only ever a few of these on the water at once, so each one
 * is built properly rather than instanced: planked hull, gunwales, ribs,
 * thwarts, a woven canopy, cargo, a boatman who actually pulls on his oar, and
 * a lantern that comes on after dark.
 */
export const createBoatKit = (): BoatKit => {
  const geometries: Geometry[] = [];
  const keep = <T extends Geometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };

  const hullGeometry = keep(createHullGeometry());
  const gunwale = [keep(createStrakeGeometry(-1, 0, 0.1)), keep(createStrakeGeometry(1, 0, 0.1))];
  const strakes = [
    keep(createStrakeGeometry(-1, 0.3, 0.05)),
    keep(createStrakeGeometry(1, 0.3, 0.05)),
    keep(createStrakeGeometry(-1, 0.58, 0.045)),
    keep(createStrakeGeometry(1, 0.58, 0.045)),
  ];

  const thwartGeometry = keep(new BoxGeometry(2, 0.12, 0.5));
  const soleGeometry = keep(createSoleGeometry());
  const frames = [0.2, 0.32, 0.44, 0.56, 0.68, 0.8].map((t) => keep(createFrameGeometry(t)));

  const canopyRibGeometry = keep(new TorusGeometry(BEAM * 0.54, 0.07, 5, 16, Math.PI));
  canopyRibGeometry.rotateY(Math.PI / 2);
  const coverGeometry = keep(new CylinderGeometry(BEAM * 0.53, BEAM * 0.53, LENGTH * 0.3, 18, 1, true, 0, Math.PI));
  coverGeometry.rotateZ(Math.PI / 2);
  coverGeometry.rotateY(Math.PI / 2);

  const torsoGeometry = keep(new CylinderGeometry(0.19, 0.3, 0.78, 7));
  const headGeometry = keep(new SphereGeometry(0.13, 8, 6));
  const hatGeometry = keep(new CylinderGeometry(0.01, 0.32, 0.17, 10));
  const limbGeometry = keep(new CylinderGeometry(0.055, 0.055, 0.62, 5));
  limbGeometry.translate(0, -0.31, 0);

  // 2.6 m of oar, pivoted a third of the way down at the tholepin, so 0.7 m is
  // inboard in the boatman's hands and 1.9 m reaches the water. It was 4.2 m
  // with the pivot at the grip, which put the blade 2.65 m under the surface and
  // never brought it out: a stroke nobody could see.
  const oarShaftGeometry = keep(new CylinderGeometry(0.055, 0.045, 2.6, 6));
  oarShaftGeometry.translate(0, -0.6, 0);
  const oarBladeGeometry = keep(new BoxGeometry(0.34, 0.8, 0.04));
  oarBladeGeometry.translate(0, -2.0, 0);

  const basketGeometry = keep(new CylinderGeometry(0.46, 0.34, 0.42, 12, 1, true));
  const basketRimGeometry = keep(new TorusGeometry(0.46, 0.04, 4, 12));
  basketRimGeometry.rotateX(Math.PI / 2);
  const jarGeometry = keep(new SphereGeometry(0.34, 10, 8));
  const netGeometry = keep(new TorusGeometry(0.5, 0.17, 6, 14));
  netGeometry.rotateX(Math.PI / 2);

  const mastGeometry = keep(new CylinderGeometry(0.06, 0.08, 3.4, 6));
  const flagGeometry = keep(new PlaneGeometry(0.8, 0.5));
  const lanternBodyGeometry = keep(new CylinderGeometry(0.17, 0.17, 0.3, 10));
  const lanternGlowGeometry = keep(new SphereGeometry(0.42, 10, 8));
  const cordGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 4));
  const wakeGeometry = keep(new PlaneGeometry(BEAM * 2.6, LENGTH * 1.5));
  wakeGeometry.rotateX(-Math.PI / 2);

  const materials: Material[] = [];
  const wood = WOOD_SHADES.map((shade) => {
    const material = new MeshStandardMaterial({
      color: shade,
      flatShading: true,
      roughness: 0.86,
      metalness: 0,
      side: DoubleSide,
    });
    materials.push(material);
    return material;
  });

  const makeMaterial = (options: Record<string, unknown>) => {
    const material = new MeshStandardMaterial({ flatShading: true, metalness: 0, ...options });
    materials.push(material);
    return material;
  };

  const trim = makeMaterial({ color: '#4a3a2c', roughness: 0.9 });
  const woven = makeMaterial({ color: '#c6b189', roughness: 0.95, side: DoubleSide });
  const cloth = makeMaterial({ color: '#b8441f', roughness: 0.9, side: DoubleSide });
  const skin = makeMaterial({ color: '#b08a66', roughness: 0.82 });
  const shirt = makeMaterial({ color: '#4c5f72', roughness: 0.9 });
  const hatStraw = makeMaterial({ color: '#d9c48c', roughness: 0.95, side: DoubleSide });
  const basketStraw = makeMaterial({ color: '#b39a6e', roughness: 0.95, side: DoubleSide });
  const ceramic = makeMaterial({ color: '#6d7b6a', roughness: 0.55 });
  const rope = makeMaterial({ color: '#8d8268', roughness: 0.96 });

  const lanternShell = new MeshBasicMaterial({ color: '#ff9c3a' });
  const lanternGlow = new MeshBasicMaterial({
    color: '#ffb257',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const wakeFoam = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.1, depthWrite: false });
  materials.push(lanternShell, lanternGlow, wakeFoam);

  const create = (variant: number): Boat => {
    const group = new Group();
    group.name = 'boat';
    const hullWood = wood[variant % wood.length];
    const covered = variant % 3 !== 2;

    /** Merged buffers belong to this boat alone and nothing else will free them. */
    const owned: Geometry[] = [];

    /**
     * One draw call per material rather than one per board. Thirty-eight meshes
     * a boat meant a hundred and ninety draw calls for five of them — most of
     * the frame's whole allowance — and the detail is not what cost it, the
     * topology was. Merging by material keeps every part's own roughness and
     * double-sidedness, which collapsing to one vertex-coloured material would
     * have thrown away.
     */
    const build = (parent: Object3D, parts: BoatPart[], shadows = true) => {
      const buckets = new Map<Material, BoatPart[]>();
      for (const part of parts) {
        const bucket = buckets.get(part.material);
        if (bucket) bucket.push(part);
        else buckets.set(part.material, [part]);
      }

      for (const [material, bucket] of buckets) {
        let mesh: Mesh;
        if (bucket.length === 1) {
          // Nothing to merge, so the kit's own buffer is reused rather than copied.
          mesh = new Mesh(bucket[0].geometry, material);
          const matrix = bucket[0].matrix;
          if (matrix) mesh.applyMatrix4(matrix);
        } else {
          const merged = mergeGeometries(bucket.map(bake));
          if (!merged) continue;
          owned.push(merged);
          mesh = new Mesh(merged, material);
        }
        mesh.castShadow = shadows;
        parent.add(mesh);
      }
    };

    // --- the hull and everything bolted to it ------------------------------
    const hull: BoatPart[] = [
      { geometry: hullGeometry, material: hullWood },
      { geometry: soleGeometry, material: hullWood },
      ...strakes.map((strake) => ({ geometry: strake, material: hullWood })),
      ...gunwale.map((rail) => ({ geometry: rail, material: trim })),
    ];

    /**
     * The frames, and the thwarts spanning them. The thwarts were measured off
     * the sheer and the floorboards off the keel, which in a hull this deep left
     * them 1.5 m apart — a thwart you would have needed a ladder for. A thwart is
     * 0.42 m above the sole, and it is cut to the section it crosses rather than
     * to a fraction of the widest part of the boat.
     */
    for (const frame of frames) hull.push({ geometry: frame, material: trim });
    for (let i = 0; i < 4; i += 1) {
      const t = 0.24 + i * 0.18;
      hull.push({
        geometry: thwartGeometry,
        material: trim,
        matrix: at(0, THWART, (t - 0.5) * LENGTH, sectionHalfWidth(t, THWART)),
      });
    }

    if (covered) {
      for (let i = 0; i < 4; i += 1) {
        hull.push({
          geometry: canopyRibGeometry,
          material: trim,
          matrix: at(0, DEPTH * 0.28, (i - 1.5) * LENGTH * 0.1),
        });
      }
      hull.push({ geometry: coverGeometry, material: woven, matrix: at(0, DEPTH * 0.28, 0) });
    }

    // Cargo stands on the floorboards, not at a height above the keel that the
    // floorboards no longer sit at.
    const cargoAt = (x: number, t: number, rise: number) => ({ x, y: SOLE + rise, z: (t - 0.5) * LENGTH });
    if (variant % 2 === 0) {
      for (let i = 0; i < 2; i += 1) {
        const spot = cargoAt(i === 0 ? -0.55 : 0.5, 0.72 + i * 0.08, 0.21);
        hull.push({ geometry: basketGeometry, material: basketStraw, matrix: at(spot.x, spot.y, spot.z) });
        hull.push({ geometry: basketRimGeometry, material: basketStraw, matrix: at(spot.x, spot.y + 0.21, spot.z) });
      }
    } else {
      const net = cargoAt(0.3, 0.74, 0.17);
      hull.push({ geometry: netGeometry, material: rope, matrix: at(net.x, net.y, net.z) });
    }
    const jar = cargoAt(-0.45, 0.34, 0.42);
    hull.push({ geometry: jarGeometry, material: ceramic, matrix: at(jar.x, jar.y, jar.z, 1, 1.25, 1) });

    // The mast never moves; only the flag on it does, so the pole merges into
    // the hull and the flag stays its own mesh. Stepped on the sole, where a
    // mast is stepped, rather than standing on the gunwale.
    hull.push({ geometry: mastGeometry, material: hullWood, matrix: at(0, SOLE + 1.7, LENGTH * 0.28) });

    build(group, hull);

    // --- the boatman, on a pivot so he can lean into the stroke -------------
    // On the aftmost thwart, which is what he would be sitting on. His old
    // station was read off the sheer and came out 0.01 m above the rail: with the
    // hull swamped to the gunwale that looked like standing in shallow water, and
    // with her floating properly it is a man standing on the rail.
    const rower = new Object3D();
    rower.position.set(0.9, THWART, (OAR_T - 0.5) * LENGTH);
    group.add(rower);
    build(rower, [
      { geometry: torsoGeometry, material: shirt, matrix: at(0, 0.39, 0) },
      { geometry: headGeometry, material: skin, matrix: at(0, 0.92, 0) },
      { geometry: hatGeometry, material: hatStraw, matrix: at(0, 1.0, 0) },
    ]);

    // Both arms pull together, so they share one pivot and one buffer.
    const arms = new Object3D();
    arms.position.y = 0.74;
    rower.add(arms);
    build(arms, [
      { geometry: limbGeometry, material: skin, matrix: at(-0.2, 0, 0) },
      { geometry: limbGeometry, material: skin, matrix: at(0.2, 0, 0) },
    ]);

    // --- the oar, on its own pivot at the gunwale ---------------------------
    // The tholepin beside him, and the lean that puts the blade 0.06 m under the
    // surface at mid-stroke so the recovery lifts it clear. Leaning the other way
    // — which is how it was — swung the blade inboard underneath the hull.
    const oar = new Object3D();
    oar.position.set(halfBeamAt(OAR_T), sheerAt(OAR_T), (OAR_T - 0.5) * LENGTH);
    oar.rotation.z = OAR_LEAN;
    group.add(oar);
    build(oar, [
      { geometry: oarShaftGeometry, material: hullWood },
      { geometry: oarBladeGeometry, material: hullWood },
    ]);

    const flag = new Mesh(flagGeometry, cloth);
    flag.position.set(0.4, SOLE + 3.0, LENGTH * 0.28);
    group.add(flag);

    const lantern = new Object3D();
    lantern.position.set(0, sheerAt(0.92) + 0.55, LENGTH * 0.42);
    group.add(lantern);
    const cord = new Mesh(cordGeometry, rope);
    cord.position.y = 0.25;
    lantern.add(cord);
    lantern.add(new Mesh(lanternBodyGeometry, lanternShell));
    const glow = new Mesh(lanternGlowGeometry, lanternGlow);
    lantern.add(glow);

    const wake = new Mesh(wakeGeometry, wakeFoam);
    wake.position.set(0, WATERLINE + 0.06, -LENGTH * 0.95);
    group.add(wake);

    let phase = variant * 1.7;
    let lastElapsed = 0;

    return {
      group,
      update: (elapsed, way = 0) => {
        // Integrated rather than read off `elapsed`, so the rate can change with
        // the way she is making without the stroke jumping back on itself. One
        // stroke every seven seconds lying still, every three and a half flat
        // out: reach, pull, recover.
        const delta = Math.min(0.1, Math.max(0, elapsed - lastElapsed));
        lastElapsed = elapsed;
        phase += delta * (0.9 + way * 0.9);
        const pull = Math.sin(phase);
        const dip = Math.cos(phase);

        // The harder the stroke, the further through it everything swings.
        const effort = 0.7 + way * 0.5;
        oar.rotation.y = pull * 0.42 * effort;
        oar.rotation.x = 0.1 + dip * 0.26 * effort;
        arms.rotation.x = -0.55 + pull * 0.4 * effort;
        rower.rotation.x = pull * 0.16 * effort;

        // The hull answers the stroke, and the river answers neither.
        group.rotation.z = pull * 0.018 * effort + Math.sin(elapsed * 0.83 + variant) * 0.012;
        group.rotation.x = Math.sin(elapsed * 1.21 + variant) * 0.01 - way * 0.012;

        lantern.rotation.z = Math.sin(elapsed * 1.1 + variant) * 0.13;
        flag.rotation.y = Math.sin(elapsed * 2.6 + variant) * 0.4;
        flag.scale.x = 0.85 + Math.sin(elapsed * 3.1 + variant) * 0.15;
      },
      // `visible` rather than the material's opacity, because every boat in the
      // kit shares one foam material and only this one is tied up.
      setUnderway: (making) => {
        wake.visible = making;
      },
      setNight: (amount) => {
        const lit = Math.min(1, Math.max(0, amount));
        lanternGlow.opacity = lit * 0.5;
        glow.visible = lit > 0.02;
        lanternShell.color.setHex(lit > 0.3 ? 0xffc46a : 0xb8651f);
      },
      dispose: () => {
        // mergeGeometries hands back fresh buffers that only this boat holds;
        // the kit's own geometries are shared and must survive.
        for (const geometry of owned) geometry.dispose();
        owned.length = 0;
        group.clear();
      },
    };
  };

  return {
    create,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
};

export {
  LENGTH as BOAT_LENGTH,
  BEAM as BOAT_BEAM,
  /** Keel below the waterline amidships, with her floating as designed. */
  DRAUGHT as BOAT_DRAUGHT,
  /**
   * Where the still waterline falls in the boat's own frame, which is negative
   * because the origin is up at the gunwale's own datum. Put the group at
   * `waterLevel - BOAT_WATERLINE` and she floats; put it at `waterLevel`, which
   * is what it did, and she is 1.25 m under.
   */
  WATERLINE as BOAT_WATERLINE,
  /** The floorboards, in the boat's own frame: where a passenger's feet go. */
  SOLE as BOAT_SOLE,
};
