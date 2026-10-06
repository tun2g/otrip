/**
 * The materials every vehicle shares, and the one function that hangs a `Build`
 * on its pivots.
 *
 * This was `assemble` inside `createVehicles`, a closure over that function's
 * materials and its one `group`. It had to come out, because there was no way to
 * ask for a single motorbike: a companion on a bike has to be drawn on a bike,
 * `avatars.ts` has no fleet, and building a second set of materials for it would
 * be the one thing `vehicles.ts` says not to do — "what is shared is the
 * materials; each vehicle's static bodywork is merged into one vertex-coloured
 * geometry" — and would also compile a second pair of shaders, on whichever
 * frame somebody happened to mount.
 *
 * So one kit, two consumers. The fleet makes it and owns its lifetime; the
 * companions' machines borrow it. The lamp and tail colours are the kit's too,
 * which is not a convenience: night is night, and a companion's tail light going
 * red at a different moment from the bus in front of them is a bug nobody would
 * ever find the cause of.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type Material,
} from 'three';

import { mergeParts, type Part } from './road-network';
import type { Build } from './vehicle-builds';
import { SPECS, type VehicleKind } from './vehicle-specs';

/**
 * The render layer a machine being ridden is put on, so the cockpit pass can
 * draw it and nothing else.
 *
 * It lives here because it is a property of the rigs this kit assembles, and
 * both ends of the arrangement have to agree on one number: `vehicles.ts` turns
 * it on at `mount` and off at `park`, and `world-renderer.ts` points the cockpit
 * camera at it. Layer 0 stays on throughout — the machine is still part of the
 * world and is still drawn by the world's own camera in third person.
 *
 * This is what makes the cockpit free. The alternative was a second motorbike
 * built for the first-person view, which would be another merged geometry to
 * keep in step with the one being ridden; the alternative to *that* was
 * reparenting the rig into a cockpit scene, which takes it out of the world and
 * so out of the third-person view it also has to appear in.
 */
export const COCKPIT_LAYER = 1;

const LAMP_DAY = new Color('#43443e');
const LAMP_NIGHT = new Color('#fff0c8');
const TAIL_DAY = new Color('#4a2420');
const TAIL_NIGHT = new Color('#c4291e');

type Swing = { node: Object3D; phase: number; gain: number };

/** One assembled vehicle, with every node anything will ever want to move. */
export type Rig = {
  group: Group;
  rearAxle: Object3D;
  frontAxle: Object3D;
  steer: Object3D | null;
  rider: Object3D | null;
  swings: Swing[];
  tail: Mesh | null;
  glow: Mesh | null;
};

export type VehicleKit = {
  /**
   * One vehicle, detached. The rig's group belongs to whoever asked — it is not
   * added to anything here, because the fleet keeps its vehicles in one group
   * and the companions' machines live under `avatars.group` beside the bodies
   * they replace.
   */
  assemble: (kind: VehicleKind, build: Build) => Rig;
  /**
   * Switches every lamp and tail lens in every consumer between day and night,
   * 0 to 1. The materials are shared, so this is one call for the whole world
   * and each consumer only has to decide which of its own glow cones to show.
   */
  setLit: (amount: number) => void;
  /** 0 to 1 of the way to night, as `setLit` last left it. */
  lit: () => number;
  /** The unlit red lens a vehicle swaps to while its brakes are on. */
  brakeMaterial: Material;
  /** And the one it swaps back to. */
  tailMaterial: Material;
  dispose: () => void;
};

/**
 * Nothing here is instanced. At sixteen vehicles plus a room's worth of
 * companions the win would be a few draw calls and the cost would be every
 * detail that makes a motorbike read as a motorbike. What is shared is the
 * materials, and each vehicle's static bodywork is merged into one
 * vertex-coloured geometry, so a bike with ninety parts still costs one draw
 * call for its body.
 */
export const createVehicleKit = (): VehicleKit => {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  const bodyMaterial = keep(
    new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.55,
      metalness: 0.08,
      side: DoubleSide,
    })
  );
  const glassMaterial = keep(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
      side: DoubleSide,
    })
  );
  // Unlit materials, so their colour is the whole of their brightness: by day
  // the lenses have to be dark glass or they glow at noon, which is the mistake
  // that made the river turquoise at midnight.
  const lampMaterial = keep(new MeshBasicMaterial({ color: LAMP_DAY.clone() }));
  const tailMaterial = keep(new MeshBasicMaterial({ color: TAIL_DAY.clone() }));
  const brakeMaterial = keep(new MeshBasicMaterial({ color: new Color('#ff3a24') }));
  const glowMaterial = keep(
    new MeshBasicMaterial({
      color: new Color('#ffe7b8'),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
  );

  // One cone, shared by everything with a headlight: apex at the lamp, mouth
  // seven metres down the road.
  const glowGeometry = new ConeGeometry(1.25, 7, 10, 1, true);
  glowGeometry.rotateX(-Math.PI / 2);
  glowGeometry.translate(0, 0, 3.5);
  geometries.push(glowGeometry);

  let lit = 0;

  const addMesh = (parent: Object3D, parts: Part[], material: Material, shift: number): Mesh | null => {
    if (parts.length === 0) return null;
    // mergeParts consumes its inputs, so a Build is good for exactly one rig.
    if (shift !== 0) for (const part of parts) part.geometry.translate(0, 0, shift);
    const geometry = mergeParts(parts);
    if (!geometry) return null;
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    geometries.push(geometry);
    parent.add(mesh);
    return mesh;
  };

  return {
    brakeMaterial,
    tailMaterial,
    lit: () => lit,
    setLit: (amount) => {
      lit = Math.min(1, Math.max(0, amount));
      lampMaterial.color.copy(LAMP_DAY).lerp(LAMP_NIGHT, lit);
      tailMaterial.color.copy(TAIL_DAY).lerp(TAIL_NIGHT, lit);
      glowMaterial.opacity = lit * 0.085;
    },

    /**
     * Hangs one Build on its pivots. Every part list arrives in vehicle
     * coordinates and is rebased here, which is the only place that has to know
     * where a node sits — do it in the builders and a lamp ends up half a metre
     * behind the wheel it is bolted to.
     */
    assemble: (kind, build) => {
      const spec = SPECS[kind];
      const vehicle = new Group();
      vehicle.name = kind;
      // Yaw, then pitch, then roll in the body's own frame. The default XYZ order
      // applies pitch in world space, which tips a cornering vehicle sideways.
      vehicle.rotation.order = 'YXZ';

      addMesh(vehicle, build.body, bodyMaterial, 0);
      addMesh(vehicle, build.glass, glassMaterial, 0);

      const rearAxle = new Object3D();
      rearAxle.position.set(0, spec.wheelRadius, spec.rearAxle);
      vehicle.add(rearAxle);
      addMesh(rearAxle, build.rearWheel, bodyMaterial, 0);

      const steer = spec.steersFront ? new Object3D() : null;
      if (steer) {
        steer.position.set(0, 0, spec.frontAxle);
        vehicle.add(steer);
        addMesh(steer, build.steer, bodyMaterial, -spec.frontAxle);
      } else {
        addMesh(vehicle, build.steer, bodyMaterial, 0);
      }

      const frontAxle = new Object3D();
      if (steer) {
        frontAxle.position.set(0, spec.wheelRadius, 0);
        steer.add(frontAxle);
      } else {
        frontAxle.position.set(0, spec.wheelRadius, spec.frontAxle);
        vehicle.add(frontAxle);
      }
      addMesh(frontAxle, build.frontWheel, bodyMaterial, 0);

      // On two wheels the headlight swings with the bars, which is most of why a
      // motorbike at night reads as a motorbike and not a lamp on a rail.
      const onSteer = spec.lampOnSteer && steer !== null;
      const lampParent = onSteer && steer ? steer : vehicle;
      const lampShift = onSteer ? -spec.frontAxle : 0;
      addMesh(lampParent, build.head, lampMaterial, lampShift);
      const tail = addMesh(vehicle, build.tail, tailMaterial, 0);

      let glow: Mesh | null = null;
      if (build.lamp) {
        glow = new Mesh(glowGeometry, glowMaterial);
        glow.position.set(build.lamp[0], build.lamp[1], build.lamp[2] + lampShift);
        glow.visible = false;
        lampParent.add(glow);
      }

      const rider = build.rider.length > 0 ? new Object3D() : null;
      if (rider) {
        vehicle.add(rider);
        addMesh(rider, build.rider, bodyMaterial, 0);
      }

      const swings: Swing[] = [];
      for (const entry of build.swing) {
        const node = new Object3D();
        node.position.set(entry.at[0], entry.at[1], entry.at[2]);
        vehicle.add(node);
        // Swing parts are given relative to their own pivot already.
        addMesh(node, entry.parts, bodyMaterial, 0);
        swings.push({ node, phase: entry.phase, gain: entry.gain });
      }

      return { group: vehicle, rearAxle, frontAxle, steer, rider, swings, tail, glow };
    },

    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
};
