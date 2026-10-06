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

import type { AvatarRides, RiderRig } from './avatar-ride';
import { createHuman, TARGET_HEIGHT, type Human, type HumanSource } from './human';
import { createConicalHat, createPersonParts, PERSON_HEIGHT } from './person';

export type RemotePlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * Where the machine points, which is not where the rider looks. Once somebody
   * is riding, `yaw` is their own view heading and the vehicle has its own — a
   * bike on a left-hander is pointed into the bend while the rider's head is
   * already down the exit.
   */
  heading: number;
  /**
   * '' on foot, otherwise the vehicle kind they are on.
   *
   * This is the field that stops a companion being drawn as a jogger covering
   * 25 m/s, which is the giveaway that nothing is synchronised. The roster of
   * kinds lives in `vehicles.ts` and never reaches the server, so the room
   * bounds this by shape and length rather than against a list.
   */
  riding: string;
  /** m/s, so a companion's wheels and lean can be driven without having to
   *  differentiate positions that arrive at whatever rate the network manages. */
  speed: number;
  racing: boolean;
  lap: number;
  check: number;
  /** Milliseconds. 0 is "no time yet", not zero. */
  bestMs: number;
  finishedMs: number;
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

/**
 * Whether a position from the room is a position at all.
 *
 * Defensive, and known to be defensive: this was written while chasing a report
 * of two people in one room seeing nothing of each other, on the theory that an
 * `onStateChange` can fire when a player is added but before their fields are
 * decoded. That theory was then **disproved** — measured on the live site with
 * two browsers and a fresh join, the companion renders correctly at 88 px, so no
 * such frame was ever observed and this is not the cause of anything reported.
 *
 * It stays because the failure it prevents is unrecoverable rather than merely
 * wrong, which is a bad property to leave in reach. An unvalidated position goes
 * into `avatar.position`, and from there a NaN never leaves: `position.lerp`
 * propagates it, and the teleport escape below cannot clear it either. One bad
 * frame from anywhere — a future field added to the schema, a hand-rolled test
 * harness, a reconnect that races a decode — would pin an avatar at an
 * unrenderable position for the rest of the session, with nothing in the console
 * and a roster that still says the player is there. `probe/avatar-sync.ts`
 * demonstrates both the latch and this guard.
 */
const placed = (player: RemotePlayer): boolean =>
  Number.isFinite(player.x) && Number.isFinite(player.y) && Number.isFinite(player.z);
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
  /**
   * The nodes that *are* the walking figure — the rig's own group, or the
   * primitive body and its hat. Collected rather than reached for, because what
   * has to be hidden once somebody is on a machine differs between the two and
   * the label must never be: a name you cannot see is a companion you cannot
   * find, which is the whole reason the sprite has `depthTest: false`.
   */
  body: Object3D[];
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
  /**
   * The machine under them, or null on foot. Claimed in `sync` — which runs at
   * the room's rate, not the frame's — so a companion mounting never costs the
   * frame it happens on anything but a `visible = true`.
   */
  rig: RiderRig | null;
  /** What `riding` said when the rig was claimed, so a change can be noticed. */
  riding: string;
  /** The heading and speed of the machine, as the room last reported them. */
  heading: number;
  machineSpeed: number;
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
 *
 * That still holds for the feet and no longer holds for a wheel. `RemotePlayer`
 * now carries `riding`, `heading` and `speed`, and a companion on a machine is
 * handed to `avatar-ride.ts` to be drawn as one: the walking body stands down,
 * the machine's own seated figure takes over, and the wheels turn at the speed
 * the room reported rather than at the speed the easing happened to produce.
 *
 * @param rides the companions' machines. Omitted — in `probe/avatar-sync.ts`,
 *   and anywhere the fleet has not been built — a rider is drawn as a walking
 *   body, which is the behaviour this file had before and not a new failure.
 */
export const createAvatars = (humanSource?: HumanSource, rides?: AvatarRides): Avatars => {
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

    rides?.release(id);
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
    const body: Object3D[] = [];
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
      body.push(human.group);
    } else {
      const bodyMaterial = new MeshStandardMaterial({
        color: new Color(colour),
        flatShading: true,
        roughness: 0.92,
        metalness: 0,
      });
      materials.push(bodyMaterial);
      const torso = new Mesh(parts.body, bodyMaterial);
      const hat = new Mesh(parts.hat, hatMaterial);
      torso.castShadow = true;
      hat.castShadow = true;
      avatar.add(torso, hat);
      body.push(torso, hat);
    }

    const label = createLabel();
    label.sprite.position.y = labelHeight + 0.55;
    avatar.add(label.sprite);

    return {
      group: avatar,
      human,
      body,
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
      rig: null,
      riding: '',
      heading: player.heading,
      machineSpeed: 0,
    };
  };

  const previous = new Vector3();

  return {
    group,
    sync: (players) => {
      const seen = new Set<string>();

      for (const player of players) {
        // Held out of the roster entirely rather than created at a position that
        // is not one: `seen` is what decides who survives the sweep below, so an
        // unplaced player is simply not in the room yet, and the next snapshot —
        // which is at most a tenth of a second away — admits them.
        if (!placed(player)) continue;
        seen.add(player.id);
        let entry = entries.get(player.id);

        if (!entry || entry.name !== player.name) {
          if (entry) remove(player.id);
          entry = create(player);
          entries.set(player.id, entry);
        }

        entry.target.set(player.x, player.y, player.z);
        entry.targetYaw = Number.isFinite(player.yaw) ? player.yaw : entry.targetYaw;

        /**
         * Which machine, claimed here rather than in `update`.
         *
         * `sync` runs when the room sends, ten times a second at most, and a rig
         * is only *claimed* — every one of them was assembled when the scene was.
         * So the frame somebody mounts on costs a map lookup and a `visible`
         * flag, which is the hard requirement: it must not be the frame that
         * merges geometry or compiles a shader.
         *
         * `riding` is bounded by the room to a lowercase token of at most 24
         * characters and never checked against a list of kinds, because the list
         * is a browser file — so `claim` is what decides whether it is something
         * that can be drawn, and a kind it does not know falls back to the
         * walking body rather than to nothing.
         */
        const riding = typeof player.riding === 'string' ? player.riding : '';
        if (riding !== entry.riding) {
          if (entry.rig) {
            entry.rig.hide();
            rides?.release(player.id);
            entry.rig = null;
          }
          entry.riding = riding;
          if (riding) entry.rig = rides?.claim(player.id, riding) ?? null;
        }
        if (Number.isFinite(player.heading)) entry.heading = player.heading;
        entry.machineSpeed = Number.isFinite(player.speed) ? player.speed : 0;
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
        //
        // Written as "not a short step" rather than "a long one". For every real
        // distance the two are the same test; for NaN they are not, because both
        // `NaN > x` and `NaN <= x` are false — so the positive form sent a figure
        // whose position had gone bad down the easing branch, where `lerp` cannot
        // recover it. Snapping onto the target is the only answer available there
        // and is also the right answer for the case this was written for.
        const teleported = !(previous.distanceToSquared(entry.target) <= SNAP * SNAP);
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

        /**
         * The machine, under the body's *eased* position and not under the
         * target the room sent — a bike placed at the target while the rider
         * eases toward it rides a tenth of a second ahead of the person on it.
         *
         * Its own heading, not `entry.group.rotation.y`: that is the rider's
         * view yaw, eased, and a bike on a left-hander is pointed into the bend
         * while the rider's head is already down the exit.
         */
        const riding = entry.rig !== null;
        if (entry.rig) {
          entry.rig.place(
            entry.group.position.x,
            entry.group.position.y,
            entry.group.position.z,
            entry.heading,
            entry.machineSpeed,
            delta
          );
        }

        // Astride something with wheels the walking body stands down, exactly as
        // the local rider's does in `walker.ts`: the figure in the saddle is the
        // machine's own, built sitting, and two bodies in one place is one too
        // many. A companion whose `riding` is a kind this cannot draw keeps their
        // walking body, which is why this is `entry.rig` and not `entry.riding`.
        for (let index = 0; index < entry.body.length; index += 1) entry.body[index].visible = !riding;

        if (entry.human && !riding) {
          const moving = entry.speed > MOVING;
          const clip = entry.speed > RUN_CLIP_AT ? 'run' : 'walk';
          const reference = clip === 'run' ? RUN_CLIP_SPEED : WALK_CLIP_SPEED;
          // Driving the clip at the rate the body is travelling is what stops the
          // feet skating: one cycle at a fixed rate cannot cover 1 m/s and 4 m/s.
          // Still the *measured* speed and not the room's `speed`, which is only
          // ever a machine's: nothing in the room says whether somebody is
          // running, so how far they moved remains the only honest signal.
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
      // Handed in rather than made here, and disposed here all the same: it was
      // put in this group, so it goes out with it. What it releases is only the
      // scene graph — its geometries and materials are the fleet's kit's.
      rides?.dispose();
      parts.dispose();
      hatGeometry.dispose();
      hatMaterial.dispose();
    },
  };
};
