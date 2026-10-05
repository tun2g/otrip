import type { Terrain } from '@otrip/world';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';

/**
 * One wing, swept back from the root, drawn as a flat silhouette. Birds in the
 * sky are read almost entirely from this outline, so the shape matters far more
 * than the shading.
 */
const createWingGeometry = (): BufferGeometry => {
  // Root at the origin, tip along +X, flight direction along +Z.
  const vertices = new Float32Array([0, 0, 0.34, 1.1, 0.04, 0.16, 0, 0, -0.34, 1.1, 0.04, -0.52, 2.05, 0.02, -0.14]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 1, 4, 3]);
  geometry.computeVertexNormals();
  return geometry;
};

/** Body and tail, pointed at both ends. */
const createBodyGeometry = (): BufferGeometry => {
  const body = new ConeGeometry(0.17, 1.35, 5);
  body.rotateX(-Math.PI / 2);
  return body;
};

const createTailGeometry = (): BufferGeometry => {
  const vertices = new Float32Array([0, 0, 0, 0.34, 0, -0.72, -0.34, 0, -0.72]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
};

type Leader = { centreX: number; centreZ: number; radius: number; height: number; speed: number; phase: number };
type Bird = {
  leader: number;
  /** Offset from the leader, in the flock's own frame. */
  side: number;
  back: number;
  lift: number;
  size: number;
  flapRate: number;
  flapPhase: number;
  /** 0 flaps constantly, 1 soars. Raptors sit near the top of this range. */
  soar: number;
};

export type Birds = {
  group: Group;
  update: (elapsed: number) => void;
  dispose: () => void;
};

/**
 * Birds, as birds. They were five-metre boxes before — correct motion, no
 * silhouette — and the sky is the one part of the scene with nothing else in
 * it, so anything moving up there gets looked at closely.
 */
export const createBirds = (terrain: Terrain, count: number, random: () => number): Birds => {
  const group = new Group();
  group.name = 'birds';

  const half = terrain.size / 2;

  // Flocks rather than a uniform scatter: a dozen birds spread evenly over a
  // kilometre of sky read as specks, the same dozen in three groups read as
  // birds going somewhere.
  const flockCount = Math.max(1, Math.round(count / 5));
  const leaders: Leader[] = Array.from({ length: flockCount }, () => ({
    centreX: (random() * 2 - 1) * half * 0.55,
    centreZ: (random() * 2 - 1) * half * 0.55,
    radius: 60 + random() * 260,
    height: terrain.maxHeight * (0.5 + random() * 0.6) + 40,
    speed: 0.09 + random() * 0.1,
    phase: random() * Math.PI * 2,
  }));

  const birds: Bird[] = Array.from({ length: count }, (_, index) => {
    // One bird in six is a lone raptor: bigger, higher, almost always soaring.
    const raptor = random() < 0.17;
    return {
      leader: index % flockCount,
      side: (random() * 2 - 1) * (raptor ? 4 : 26),
      back: (random() * 2 - 1) * (raptor ? 4 : 34),
      lift: (random() * 2 - 1) * (raptor ? 6 : 14) + (raptor ? 55 : 0),
      size: raptor ? 2.4 + random() * 0.9 : 1.0 + random() * 0.7,
      flapRate: raptor ? 1.5 + random() * 0.8 : 4.2 + random() * 3.2,
      flapPhase: random() * Math.PI * 2,
      soar: raptor ? 0.82 : 0.1 + random() * 0.4,
    };
  });

  const wingGeometry = createWingGeometry();
  const bodyGeometry = createBodyGeometry();
  const tailGeometry = createTailGeometry();

  const material = new MeshStandardMaterial({
    color: new Color('#2b2f36'),
    flatShading: true,
    roughness: 0.88,
    metalness: 0,
    // Wings are single-sided silhouettes, and the left one is a mirrored
    // instance, which reverses its winding.
    side: 2,
  });

  const bodies = new InstancedMesh(bodyGeometry, material, count);
  const tails = new InstancedMesh(tailGeometry, material, count);
  const wings = new InstancedMesh(wingGeometry, material, count * 2);
  for (const mesh of [bodies, tails, wings]) {
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  // A real hierarchy, so the wing's flap composes with the bird's heading
  // instead of being approximated by one of them winning.
  const pivot = new Object3D();
  const leftWing = new Object3D();
  const rightWing = new Object3D();
  const tail = new Object3D();
  pivot.add(leftWing, rightWing, tail);
  leftWing.scale.x = -1;
  tail.position.z = -0.6;

  const position = new Vector3();

  const update = (elapsed: number) => {
    birds.forEach((bird, index) => {
      const leader = leaders[bird.leader];
      const angle = leader.phase + elapsed * leader.speed;
      const forwardX = -Math.sin(angle);
      const forwardZ = Math.cos(angle);

      position.set(
        leader.centreX + Math.cos(angle) * leader.radius,
        leader.height + Math.sin(elapsed * 0.5 + leader.phase) * 12 + bird.lift,
        leader.centreZ + Math.sin(angle) * leader.radius
      );
      // Offsets are in the flock's frame: `back` along the line of flight,
      // `side` across it, so the formation holds its shape through the turn.
      position.x += forwardX * bird.back + forwardZ * bird.side;
      position.z += forwardZ * bird.back - forwardX * bird.side;

      // Bursts of flapping between glides. A constant beat is the thing that
      // gives away a looping animation.
      const burst = Math.max(0, Math.sin(elapsed * 0.35 + bird.flapPhase) - bird.soar) / (1 - bird.soar);
      const beat = Math.sin(elapsed * bird.flapRate + bird.flapPhase * 3);
      const flap = beat * (0.18 + burst * 0.95);

      pivot.position.copy(position);
      pivot.rotation.set(0, -angle, 0);
      pivot.scale.setScalar(bird.size);
      // Banking into the turn, plus a little from the flap itself.
      pivot.rotation.z = 0.12 + flap * 0.06;
      leftWing.rotation.z = -flap;
      rightWing.rotation.z = flap;
      // The tail fans and tilts with the stroke; it is a small thing that
      // stops the body reading as a rigid dart.
      tail.rotation.x = flap * 0.18;
      pivot.updateMatrixWorld(true);

      bodies.setMatrixAt(index, pivot.matrixWorld);
      tails.setMatrixAt(index, tail.matrixWorld);
      wings.setMatrixAt(index * 2, leftWing.matrixWorld);
      wings.setMatrixAt(index * 2 + 1, rightWing.matrixWorld);
    });

    if (count > 0) {
      bodies.instanceMatrix.needsUpdate = true;
      tails.instanceMatrix.needsUpdate = true;
      wings.instanceMatrix.needsUpdate = true;
    }
  };

  update(0);

  return {
    group,
    update,
    dispose: () => {
      for (const geometry of [wingGeometry, bodyGeometry, tailGeometry]) geometry.dispose();
      (material as Material).dispose();
      for (const mesh of [bodies, tails, wings]) mesh.dispose();
    },
  };
};
