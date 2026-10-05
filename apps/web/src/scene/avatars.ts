import {
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  type Material,
} from 'three';

import { createHuman, TARGET_HEIGHT, type Human, type HumanSource } from './human';
import { createConicalHat, createPersonParts, PERSON_HEIGHT } from './person';

export type RemotePlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
};

/**
 * A room holds eight, so every person in it can have the rigged model. The
 * budget exists because each one carries its own animation mixer, and the fall
 * back to the stylised figure is what keeps a larger room from stuttering.
 */
const MAX_RIGGED = 8;

/**
 * The gait ladder, shared with the walker so your own feet and a friend's obey
 * the same rules. Clip speeds are what the animation looks authored for.
 */
const RUN_CLIP_AT = 3.2;
const WALK_CLIP_SPEED = 1.45;
const RUN_CLIP_SPEED = 4.2;
const MAX_CLIP_RATE = 2.2;
/** Below this, m/s, a figure is standing rather than walking slowly. */
const MOVING = 0.15;

/** Metres of jump that mean a teleport rather than a walk — travelling to a place. */
const SNAP = 25;
/** Exponential ease toward the last known position. The room sends ten a second. */
const EASE_RATE = 9;

const LABEL_WIDTH = 320;
const LABEL_HEIGHT = 72;
/** Metres of label per metre of range, so a name holds its size on screen. */
const LABEL_SPAN = 0.069;
/** Past this, in metres, the name alone no longer answers "where are they". */
const LABEL_DISTANCE_FROM = 70;

const UP = new Vector3(0, 1, 0);

/** Stable per-person colour, so the same friend is the same colour all trip. */
const colourFor = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hues = ['#b4552f', '#2f6fb4', '#3f8a52', '#8a5aa8', '#b48a2f', '#2f8a8a'];
  return hues[hash % hues.length];
};

/** Matches the world map, so one companion reads the same in both places. */
const formatDistance = (metres: number): string =>
  metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;

const createLabel = (): { sprite: Sprite; canvas: HTMLCanvasElement; texture: Texture; material: SpriteMaterial } => {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_WIDTH;
  canvas.height = LABEL_HEIGHT;

  const texture = new Texture(canvas);
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new Sprite(material);
  sprite.renderOrder = 50;

  return { sprite, canvas, texture, material };
};

const paintLabel = (canvas: HTMLCanvasElement, name: string, distance: string) => {
  const context = canvas.getContext('2d');
  if (!context) return;

  context.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  context.font = '600 30px system-ui, sans-serif';
  const text = distance ? `${name} · ${distance}` : name;
  const width = Math.min(LABEL_WIDTH - 12, context.measureText(text).width + 32);

  context.fillStyle = 'rgba(11, 16, 32, 0.72)';
  context.beginPath();
  context.roundRect((LABEL_WIDTH - width) / 2, 12, width, 48, 14);
  context.fill();

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#f2ece2';
  context.fillText(text, LABEL_WIDTH / 2, 37, width - 24);
};

/**
 * Hangs the hat off the skull itself rather than a guessed height. The offset
 * comes from where the rig puts the top of the head and the scale from the bone's
 * own world matrix, so neither depends on how the model happened to be exported.
 */
const attachHat = (human: Human, geometry: BufferGeometry, material: Material) => {
  const bones = new Map<string, Object3D>();
  human.group.traverse((node) => bones.set(node.name.toLowerCase(), node));

  const head = bones.get('head');
  const headTop = bones.get('headtop_end');
  if (!head) return;

  head.updateWorldMatrix(true, false);
  const scale = new Vector3().setFromMatrixScale(head.matrixWorld).x;
  if (!(scale > 0)) return;

  const skull = headTop ? headTop.position.clone() : new Vector3(0, 1, 0);
  if (skull.lengthSq() < 1e-9) skull.set(0, 1, 0);

  const hat = new Mesh(geometry, material);
  hat.position.copy(skull).multiplyScalar(0.8);
  hat.quaternion.setFromUnitVectors(UP, skull.clone().normalize());
  hat.scale.setScalar(1 / scale);
  hat.castShadow = true;
  head.add(hat);
};

type Entry = {
  group: Group;
  human: Human | null;
  /** Materials this avatar owns. The rig clone shares its geometry, never these. */
  materials: Material[];
  label: Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: Texture;
  labelMaterial: SpriteMaterial;
  labelHeight: number;
  painted: string;
  target: Vector3;
  targetYaw: number;
  /** Metres per second the figure is covering on screen, eased. */
  speed: number;
  name: string;
};

export type Avatars = {
  group: Group;
  /** Replace the whole roster; entries not present are removed. */
  sync: (players: RemotePlayer[]) => void;
  /** @param viewer the camera, so a companion's name can also say how far off they are. */
  update: (delta: number, viewer?: { x: number; z: number; y?: number }) => void;
  dispose: () => void;
};

/**
 * The other people in the room. They are the reason the app exists, so they get
 * the same rigged body the villagers already have rather than the cylinder that
 * stood in for a person before — with the nón lá kept, because that is the thing
 * a traveller recognises from across a field.
 *
 * Positions arrive at whatever rate the network manages, so each avatar is eased
 * toward its last known position rather than snapped, and the walk cycle is
 * driven by how fast it is actually covering ground. Nothing in the room tells
 * us whether somebody is running; the only honest signal is how far they moved.
 */
export const createAvatars = (humanSource?: HumanSource): Avatars => {
  const parts = createPersonParts();
  const hatGeometry = createConicalHat();
  const hatMaterial = new MeshStandardMaterial({
    color: new Color('#f0dba8'),
    roughness: 0.9,
    metalness: 0,
    side: DoubleSide,
  });

  const group = new Group();
  group.name = 'avatars';

  const entries = new Map<string, Entry>();
  let rigged = 0;

  const remove = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;

    group.remove(entry.group);
    if (entry.human) {
      entry.human.dispose();
      rigged -= 1;
    }
    for (const material of entry.materials) material.dispose();
    entry.labelTexture.dispose();
    entry.labelMaterial.dispose();
    entries.delete(id);
  };

  const create = (player: RemotePlayer): Entry => {
    const colour = colourFor(player.id);
    const avatar = new Group();
    avatar.position.set(player.x, player.y, player.z);
    group.add(avatar);

    const materials: Material[] = [];
    let human: Human | null = null;
    let labelHeight = PERSON_HEIGHT;

    if (humanSource && rigged < MAX_RIGGED) {
      human = createHuman(humanSource, colour);
      avatar.add(human.group);
      rigged += 1;
      labelHeight = TARGET_HEIGHT;

      // createHuman builds a fresh material per mesh and never releases them, so
      // they are collected here — before the shared hat goes on, which is not ours.
      human.group.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        if (Array.isArray(node.material)) materials.push(...node.material);
        else materials.push(node.material);
      });

      attachHat(human, hatGeometry, hatMaterial);
      human.play('idle');
    } else {
      const bodyMaterial = new MeshStandardMaterial({
        color: new Color(colour),
        flatShading: true,
        roughness: 0.92,
        metalness: 0,
      });
      materials.push(bodyMaterial);
      const body = new Mesh(parts.body, bodyMaterial);
      const hat = new Mesh(parts.hat, hatMaterial);
      body.castShadow = true;
      hat.castShadow = true;
      avatar.add(body, hat);
    }

    const label = createLabel();
    label.sprite.position.y = labelHeight + 0.55;
    avatar.add(label.sprite);

    return {
      group: avatar,
      human,
      materials,
      label: label.sprite,
      labelCanvas: label.canvas,
      labelTexture: label.texture,
      labelMaterial: label.material,
      labelHeight,
      // Not the empty string: that is a real state (a companion close enough that
      // the distance is noise), and the label would then never get its first paint.
      painted: '\u0000',
      target: new Vector3(player.x, player.y, player.z),
      targetYaw: player.yaw,
      speed: 0,
      name: player.name,
    };
  };

  const previous = new Vector3();

  return {
    group,
    sync: (players) => {
      const seen = new Set<string>();

      for (const player of players) {
        seen.add(player.id);
        let entry = entries.get(player.id);

        if (!entry || entry.name !== player.name) {
          if (entry) remove(player.id);
          entry = create(player);
          entries.set(player.id, entry);
        }

        entry.target.set(player.x, player.y, player.z);
        entry.targetYaw = player.yaw;
      }

      for (const id of [...entries.keys()]) {
        if (!seen.has(id)) remove(id);
      }
    },
    update: (delta, viewer) => {
      const ease = 1 - Math.exp(-delta * EASE_RATE);
      const settle = Math.min(1, delta * 6);

      for (const entry of entries.values()) {
        previous.copy(entry.group.position);

        // Travelling to a place crosses kilometres in one update. Easing that
        // would send the figure gliding across the map at two hundred km/h and
        // put it in the run clip for the whole trip.
        const teleported = previous.distanceToSquared(entry.target) > SNAP * SNAP;
        if (teleported) {
          entry.group.position.copy(entry.target);
          entry.speed = 0;
        } else {
          entry.group.position.lerp(entry.target, ease);
          const measured = delta > 0 ? previous.distanceTo(entry.group.position) / delta : 0;
          entry.speed += (measured - entry.speed) * settle;
        }

        const difference = Math.atan2(
          Math.sin(entry.targetYaw - entry.group.rotation.y),
          Math.cos(entry.targetYaw - entry.group.rotation.y)
        );
        entry.group.rotation.y += difference * ease;

        if (entry.human) {
          const moving = entry.speed > MOVING;
          const clip = entry.speed > RUN_CLIP_AT ? 'run' : 'walk';
          const reference = clip === 'run' ? RUN_CLIP_SPEED : WALK_CLIP_SPEED;
          // Driving the clip at the rate the body is travelling is what stops the
          // feet skating: one cycle at a fixed rate cannot cover 1 m/s and 4 m/s.
          const rate = moving ? Math.min(MAX_CLIP_RATE, Math.max(0.35, entry.speed / reference)) : 1;
          entry.human.update(delta * rate);
          entry.human.play(moving ? clip : 'idle');
        }

        const range = viewer
          ? Math.hypot(viewer.x - entry.group.position.x, viewer.z - entry.group.position.z)
          : LABEL_DISTANCE_FROM;
        const distance = viewer && range > LABEL_DISTANCE_FROM ? formatDistance(range) : '';

        if (distance !== entry.painted) {
          paintLabel(entry.labelCanvas, entry.name, distance);
          entry.labelTexture.needsUpdate = true;
          entry.painted = distance;
        }

        const span = LABEL_SPAN * Math.min(2600, Math.max(14, range));
        entry.label.scale.set(span, (span * LABEL_HEIGHT) / LABEL_WIDTH, 1);
        entry.label.position.y = entry.labelHeight + 0.3 + (span * LABEL_HEIGHT) / LABEL_WIDTH / 2;
      }
    },
    dispose: () => {
      for (const id of [...entries.keys()]) remove(id);
      parts.dispose();
      hatGeometry.dispose();
      hatMaterial.dispose();
    },
  };
};
