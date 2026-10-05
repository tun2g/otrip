import {
  AnimationMixer,
  Box3,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type AnimationClip,
  type Object3D,
} from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

const MODEL_URL = '/models/people/human.fbx';

/** Metres. The source model is authored at a different scale. */
const TARGET_HEIGHT = 1.78;

export type HumanSource = {
  prototype: Object3D;
  clips: AnimationClip[];
  /** Uniform scale that brings the model to TARGET_HEIGHT. */
  scale: number;
  /** Metres to lift the model so its feet, not its origin, sit on the ground. */
  feetOffset: number;
  /**
   * Metres of ground one cycle of each clip was authored to cover, by clip name.
   * Without it a clip is played at whatever rate looks plausible and the feet
   * skate; with it the rate is the one number that makes them stick.
   */
  strides: Map<string, number>;
};

/** How finely a clip is walked when the ground it covers is measured. */
const STRIDE_SAMPLES = 192;
/**
 * The share of a cycle taken as the part a foot is on the ground for. A run
 * spends about two thirds of its cycle with neither foot down, and a fit that
 * counts those frames fits the swing rather than the stance — which is how the
 * first version of this put the run clip at 3.7 m/s *backwards*.
 */
const STANCE_SHARE = 0.3;
/** Metres a second the search steps through, and how far either way it reaches. */
const SPEED_STEP = 0.2;
const SPEED_REACH = 14;
const REFINE_PASSES = 5;

/**
 * Metres one cycle of each clip covers, measured off the rig instead of guessed.
 *
 * A clip is drawn in place, so the ground is what moves: run the body forward at
 * the speed it was authored for and the planted foot stands still. That is the
 * definition this searches for — the body speed that leaves a foot with nothing
 * to slide on — and it checks itself, because the slip left over at the answer
 * says how well the clip holds still at all. Measured here: Walk 1.750 m/s with
 * 0.006 m/s of slip left, Run 5.740 m/s with 0.078. So one cycle covers 1.750 m
 * walking and 3.587 m running.
 *
 * What this replaced took the frame the toes are furthest apart and doubled the
 * gap. That is the step length in a walk, where both feet are down together at
 * full split, and it is nowhere near it in a run, where the split happens in
 * mid-air: a run's stance is only a third of its cycle, so the widest gap is
 * about the ground covered in that third, not in the whole stride. It called the
 * run clip 2.610 m against the true 3.587 — 27% short, so the rate came out 37%
 * high and the legs churned that much faster than the body moved. The table that
 * signed that off reported 0% skate at every speed, which it could not help
 * doing: it worked the feet out from the same stride number the rate came from,
 * so the error cancelled and only ever proved the division had been done the
 * right way up.
 *
 * The search is swept, not descended. The swing foot comes forward about as fast
 * as the ground goes back, so there is a second, shallower basin at a negative
 * speed where it is the swing that gets cancelled, and a hill-climb from either
 * end lands in whichever basin it started nearest — it put the walk at 3.7 m/s.
 */
const measureStrides = (object: Object3D, clips: AnimationClip[], scale: number): Map<string, number> => {
  const strides = new Map<string, number>();
  const left = object.getObjectByName('LeftToeBase');
  const right = object.getObjectByName('RightToeBase');
  if (!left || !right) return strides;

  // The pose is put back afterwards: every walker in the scene is cloned from
  // this object, and leaving it stopped halfway through a clip would hand the
  // ones whose own clip misses a bone that bone's mid-stride angle. Position as
  // well as rotation, because the clips carry a track for each and the hips
  // travel on theirs.
  const pose = new Map<Object3D, { rotation: Quaternion; offset: Vector3 }>();
  object.traverse((node) => pose.set(node, { rotation: node.quaternion.clone(), offset: node.position.clone() }));

  const mixer = new AnimationMixer(object);
  const toe = new Vector3();
  const count = STRIDE_SAMPLES + 1;
  const toeX = new Float64Array(count * 2);
  const toeZ = new Float64Array(count * 2);
  const stepLeft = new Float64Array(STRIDE_SAMPLES);
  const stepRight = new Float64Array(STRIDE_SAMPLES);
  const quiet = new Float64Array(STRIDE_SAMPLES);
  const take = Math.max(1, Math.round(STRIDE_SAMPLES * STANCE_SHARE));

  for (const clip of clips) {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();

    for (let step = 0; step < count; step += 1) {
      mixer.setTime((step / STRIDE_SAMPLES) * clip.duration);
      object.updateMatrixWorld(true);
      toe.setFromMatrixPosition(left.matrixWorld);
      toeX[step * 2] = toe.x * scale;
      toeZ[step * 2] = toe.z * scale;
      toe.setFromMatrixPosition(right.matrixWorld);
      toeX[step * 2 + 1] = toe.x * scale;
      toeZ[step * 2 + 1] = toe.z * scale;
    }

    // Which way the clip walks, taken off the feet rather than assumed: they
    // swing fore and aft several times further than they ever move sideways, so
    // the principal axis of their own travel is the line of march. Assuming the
    // rig's +Z would work for this model and go wrong in silence for the next.
    let meanX = 0;
    let meanZ = 0;
    for (let index = 0; index < count * 2; index += 1) {
      meanX += toeX[index];
      meanZ += toeZ[index];
    }
    meanX /= count * 2;
    meanZ /= count * 2;
    let spanXX = 0;
    let spanXZ = 0;
    let spanZZ = 0;
    for (let index = 0; index < count * 2; index += 1) {
      const dx = toeX[index] - meanX;
      const dz = toeZ[index] - meanZ;
      spanXX += dx * dx;
      spanXZ += dx * dz;
      spanZZ += dz * dz;
    }
    const theta = 0.5 * Math.atan2(2 * spanXZ, spanXX - spanZZ);
    const axisX = Math.cos(theta);
    const axisZ = Math.sin(theta);

    const seconds = clip.duration / STRIDE_SAMPLES;
    for (let step = 0; step < STRIDE_SAMPLES; step += 1) {
      const here = step * 2;
      const next = (step + 1) * 2;
      stepLeft[step] = (toeX[next] - toeX[here]) * axisX + (toeZ[next] - toeZ[here]) * axisZ;
      stepRight[step] = (toeX[next + 1] - toeX[here + 1]) * axisX + (toeZ[next + 1] - toeZ[here + 1]) * axisZ;
    }

    /** How much a foot slides, over the stance part of the cycle only. */
    const slipAt = (speed: number): number => {
      const carried = speed * seconds;
      for (let step = 0; step < STRIDE_SAMPLES; step += 1) {
        quiet[step] = Math.min(Math.abs(stepLeft[step] + carried), Math.abs(stepRight[step] + carried));
      }
      quiet.sort();
      let total = 0;
      for (let index = 0; index < take; index += 1) total += quiet[index];
      return total / take / seconds;
    };

    let authored = 0;
    let least = Infinity;
    for (let speed = -SPEED_REACH; speed <= SPEED_REACH; speed += SPEED_STEP) {
      const slip = slipAt(speed);
      if (slip >= least) continue;
      least = slip;
      authored = speed;
    }
    for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
      const fine = SPEED_STEP / 4 ** (pass + 1);
      for (let offset = -8; offset <= 8; offset += 1) {
        const slip = slipAt(authored + offset * fine);
        if (slip >= least) continue;
        least = slip;
        authored += offset * fine;
      }
    }

    strides.set(clip.name, Math.abs(authored) * clip.duration);
  }

  mixer.stopAllAction();
  for (const [node, rest] of pose) {
    node.quaternion.copy(rest.rotation);
    node.position.copy(rest.offset);
  }
  object.updateMatrixWorld(true);
  return strides;
};

let loading: Promise<HumanSource> | null = null;

/**
 * The walking figure. A rigged human with real limbs replaces the cylinder and
 * cone that stood in for people before — it is the one thing in the scene that
 * has to look like somebody rather than like geometry.
 */
export const loadHuman = (): Promise<HumanSource> => {
  if (loading) return loading;

  loading = new Promise<HumanSource>((resolve, reject) => {
    new FBXLoader().load(
      MODEL_URL,
      (object) => {
        // FBX from this source carries its own materials and a texture that is
        // often a single palette pixel; a flat lambert keeps it consistent with
        // everything else in the scene and costs less.
        object.traverse((node) => {
          if (node instanceof Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            node.material = new MeshStandardMaterial({
              color: 0xcfc3b0,
              flatShading: true,
              roughness: 0.92,
              metalness: 0,
            });
          }
        });

        // The source is authored in centimetres-ish units; measure rather than
        // guess, so a different model can be dropped in without new magic numbers.
        const box = new Box3().setFromObject(object);
        const height = Math.max(0.001, box.max.y - box.min.y);
        const clips = object.animations ?? [];

        const scale = TARGET_HEIGHT / height;
        resolve({
          prototype: object,
          clips,
          scale,
          feetOffset: -box.min.y * scale,
          strides: measureStrides(object, clips, scale),
        });
      },
      undefined,
      (cause) => reject(cause instanceof Error ? cause : new Error('Không tải được mô hình người'))
    );
  });

  return loading;
};

export type Human = {
  group: Group;
  /** Blends to a clip by name fragment, e.g. 'walk'. */
  play: (name: string) => void;
  update: (delta: number) => void;
  /**
   * Lays a breaststroke over whatever clip is playing. `phase` is in cycles and
   * `amount` is how much of the body the water has, so a wade blends into it.
   */
  swim: (phase: number, amount: number) => void;
  dispose: () => void;
};

/** Every bone's local +Y runs down the bone, so this is what a segment is aimed by. */
const DOWN_BONE = new Vector3(0, 1, 0);

/**
 * A direction in the model's own frame: +Y out through the head, +Z out through
 * the chest, +X out through the left hand. Checked rather than assumed — with
 * the pelvis at identity the rig's shoulder line puts its left at +X and its
 * face at +Z, which is also the heading the walker turns the group to.
 */
type Aim = readonly [number, number, number];

/** `[phase, upper segment, lower segment]`, held between keys by a cosine ease. */
type Stroke = ReadonlyArray<readonly [number, Aim, Aim]>;

/**
 * The arms. Out of the streamline, round in a wide catch, then the short hard
 * insweep under the chest that is all of a breaststroke's propulsion, then
 * shot forward again — which is why the glide is more than a third of it.
 */
const ARM_STROKE: Stroke = [
  [0, [0.14, 1, 0], [0.06, 1, 0]],
  [0.18, [0.78, 0.5, 0.36], [0.6, 0.66, 0.45]],
  [0.34, [0.66, -0.1, 0.74], [0.1, 0.2, 0.97]],
  [0.5, [0.28, 0.1, 0.95], [0.04, 0.9, 0.42]],
  [0.66, [0.14, 1, 0], [0.06, 1, 0]],
  [1, [0.14, 1, 0], [0.06, 1, 0]],
];

/**
 * The legs, half a beat behind the arms: heels drawn up while the arms recover,
 * the whip out and back while they are stretched ahead. Kicking on the same beat
 * as the pull is the one thing that reads as thrashing rather than swimming.
 */
const LEG_STROKE: Stroke = [
  [0, [0.05, -1, 0.02], [0.03, -1, 0]],
  [0.3, [0.05, -1, 0.02], [0.03, -1, 0]],
  [0.5, [0.3, -0.92, 0.26], [0.36, 0.3, -0.88]],
  [0.68, [0.62, -0.76, 0.1], [0.66, -0.6, -0.45]],
  [0.84, [0.05, -1, 0.02], [0.03, -1, 0]],
  [1, [0.05, -1, 0.02], [0.03, -1, 0]],
];

const SPINE_FLAT: Aim = [0, 1, 0];
const SPINE_ARCHED: Aim = [0, 0.99, -0.14];
const NECK_DOWN: Aim = [0, 1, 0.06];
/** Prone, lifting the chin is tipping the head towards the back of the body. */
const NECK_BREATH: Aim = [0, 0.9, -0.44];

const easeBetween = (value: number): number => (1 - Math.cos(Math.PI * value)) / 2;

const sampleStroke = (stroke: Stroke, phase: number, lower: boolean, side: number, into: Vector3): Vector3 => {
  let index = stroke.length - 2;
  while (index > 0 && stroke[index][0] > phase) index -= 1;

  const [fromPhase, fromUpper, fromLower] = stroke[index];
  const [toPhase, toUpper, toLower] = stroke[index + 1];
  const from = lower ? fromLower : fromUpper;
  const to = lower ? toLower : toUpper;
  const blend = easeBetween(toPhase === fromPhase ? 0 : (phase - fromPhase) / (toPhase - fromPhase));

  return into
    .set(
      (from[0] + (to[0] - from[0]) * blend) * side,
      from[1] + (to[1] - from[1]) * blend,
      from[2] + (to[2] - from[2]) * blend
    )
    .normalize();
};

export const createHuman = (source: HumanSource, colour: string): Human => {
  const group = new Group();
  const model = cloneSkeleton(source.prototype);

  model.traverse((node: Object3D) => {
    if (node instanceof Mesh) {
      node.material = new MeshStandardMaterial({ color: colour, flatShading: true, roughness: 0.92, metalness: 0 });
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });

  model.scale.setScalar(source.scale);
  // The rig's origin sits at the hips, so without this the figure stands buried
  // to the waist — or vanishes entirely on a slope.
  model.position.y = source.feetOffset;
  group.add(model);

  const mixer = new AnimationMixer(model);
  let current: string | null = null;

  const play = (name: string) => {
    if (current === name) return;
    const clip = source.clips.find((entry) => entry.name.toLowerCase().includes(name));
    if (!clip) return;

    mixer.stopAllAction();
    mixer.clipAction(clip).reset().fadeIn(0.2).play();
    current = name;
  };

  const bone = (name: string): Object3D | null => model.getObjectByName(name) ?? null;
  const pelvis = bone('Hips');
  const spine = [bone('Spine'), bone('Spine1'), bone('Spine2')];
  const neck = bone('Neck');
  const arms = [-1, 1].map((side) => ({
    side,
    upper: bone(side < 0 ? 'RightArm' : 'LeftArm'),
    lower: bone(side < 0 ? 'RightForeArm' : 'LeftForeArm'),
  }));
  const legs = [-1, 1].map((side) => ({
    side,
    upper: bone(side < 0 ? 'RightUpLeg' : 'LeftUpLeg'),
    lower: bone(side < 0 ? 'RightLeg' : 'LeftLeg'),
    foot: bone(side < 0 ? 'RightFoot' : 'LeftFoot'),
  }));

  const modelQuaternion = new Quaternion();
  const parentQuaternion = new Quaternion();
  const aimed = new Quaternion();
  const direction = new Vector3();

  /**
   * Points a bone along a direction given in the model's frame, whatever the
   * clip underneath has done to the joints above it.
   *
   * The ancestors are brought up to date first because nothing has rendered
   * since the mixer wrote this frame: reading a stale world rotation aims the
   * arm by where the shoulder was last frame, which at a stroke a second is a
   * limb that shakes instead of swimming.
   */
  const aim = (node: Object3D | null, towards: Vector3, amount: number) => {
    const parent = node?.parent;
    if (!node || !parent) return;

    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(parentQuaternion).invert();
    direction.copy(towards).applyQuaternion(modelQuaternion).applyQuaternion(parentQuaternion);
    aimed.setFromUnitVectors(DOWN_BONE, direction);
    node.quaternion.slerp(aimed, amount);
  };

  const upper = new Vector3();
  const lower = new Vector3();

  const swim = (phase: number, amount: number) => {
    if (amount <= 0.002 || !pelvis) return;

    const cycle = phase - Math.floor(phase);
    // One breath a stroke, taken on the insweep — the only part of the cycle
    // where the head is being lifted by something rather than held up.
    const rising = easeBetween(Math.min(1, Math.max(0, (cycle - 0.16) / 0.16)));
    const falling = easeBetween(Math.min(1, Math.max(0, (cycle - 0.38) / 0.24)));
    const breath = rising * (1 - falling);

    const between = (rest: Aim, lifted: Aim, into: Vector3): Vector3 =>
      into
        .set(
          rest[0] + (lifted[0] - rest[0]) * breath,
          rest[1] + (lifted[1] - rest[1]) * breath,
          rest[2] + (lifted[2] - rest[2]) * breath
        )
        .normalize();

    model.updateWorldMatrix(true, false);
    model.getWorldQuaternion(modelQuaternion);

    // Square to the direction of travel. The clip underneath carries the rig's
    // own 43° pelvis twist, and a swimmer who crabs is the whole illusion gone.
    aim(pelvis, upper.set(0, 1, 0), amount);
    for (const segment of spine) aim(segment, between(SPINE_FLAT, SPINE_ARCHED, upper), amount * 0.7);
    aim(neck, between(NECK_DOWN, NECK_BREATH, upper), amount);

    for (const arm of arms) {
      aim(arm.upper, sampleStroke(ARM_STROKE, cycle, false, arm.side, upper), amount);
      aim(arm.lower, sampleStroke(ARM_STROKE, cycle, true, arm.side, lower), amount);
    }

    for (const leg of legs) {
      aim(leg.upper, sampleStroke(LEG_STROKE, cycle, false, leg.side, upper), amount);
      const shin = sampleStroke(LEG_STROKE, cycle, true, leg.side, lower);
      aim(leg.lower, shin, amount);
      // Toes carry on down the shin. Feet left at their walking angle are the
      // one thing that still reads as a person standing up in the river.
      aim(leg.foot, shin, amount);
    }
  };

  return {
    group,
    play,
    update: (delta) => mixer.update(delta),
    swim,
    dispose: () => {
      mixer.stopAllAction();
      group.clear();
    },
  };
};

export { TARGET_HEIGHT };
