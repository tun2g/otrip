import { CanvasTexture, Color, Group, Sprite, SpriteMaterial, Vector3 } from 'three';

import type { RemotePlayer } from './avatars';

/**
 * Stable per-person colour, so the same friend is the same colour everywhere
 * they are drawn: the body in `avatars.ts`, the ring here, the arrow in
 * `companion-compass.tsx`, the dot on the minimap. Four devices answering "where
 * is Bình" have to agree on which one Bình is.
 *
 * It lives here rather than in `avatars.ts` because three of the four callers are
 * presentation layers with no business importing a module that builds rigged
 * bodies. `avatars.ts` still holds a private copy, identical, and that copy is
 * the one to delete in favour of this import: two hashes that drift give one
 * person two colours.
 */
export const colourFor = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hues = ['#b4552f', '#2f6fb4', '#3f8a52', '#8a5aa8', '#b48a2f', '#2f8a8a'];
  return hues[hash % hues.length]!;
};

/**
 * Where a companion is relative to where you are looking from.
 *
 * `bearing` is the angle clockwise from straight ahead, wrapped to (−π, π]: so
 * negative is left, positive is right, ±π is directly behind. Both the arrow
 * glyph and the direction words are read off it.
 *
 * Derived rather than assumed: a sign error here is invisible in a screenshot
 * and wrong for every user. The walker feeds `yaw` straight to `rotation.y`, so
 * forward is `(sin yaw, 0, cos yaw)`, and it derives screen right as
 * `(-forward.z, 0, forward.x)` = `(-cos yaw, 0, sin yaw)` — `up × (eye −
 * target)`, with a long comment in `walker.ts` about having had that sign
 * inverted for everyone, joystick included. Writing `(dx, dz)` as `r·(sin a,
 * cos a)` with `a = atan2(dx, dz)`, `ahead = r·cos(a − yaw)` and `right =
 * −r·sin(a − yaw)`, so `atan2(right, ahead) = yaw − a`. That is the same
 * quantity `explore-panel.tsx` calls `bearing` and feeds to a CSS `rotate()` on
 * an `↑`, where positive is clockwise — which is why the two agree, and
 * `probe/companion-bearing.ts` prints the table that shows it.
 */
export const relativeTo = (
  viewer: { x: number; z: number; yaw: number },
  target: { x: number; z: number }
): { range: number; bearing: number } => {
  const dx = target.x - viewer.x;
  const dz = target.z - viewer.z;
  const offset = viewer.yaw - Math.atan2(dx, dz);

  return { range: Math.hypot(dx, dz), bearing: Math.atan2(Math.sin(offset), Math.cos(offset)) };
};

/** A room holds eight, so the roster of everybody else is at most seven. */
const MAX_MARKERS = 7;

const RING = 64;

/**
 * Metres of ring per metre of range, so the ring holds its size on screen.
 *
 * The frame this repo sizes screen-constant sprites against is 1080 px tall at
 * the 52° base FOV: `PLAQUE_SPAN = 0.098` in `poi-markers.ts` is "roughly a
 * hundred pixels", and 0.098 rad over 0.9076 rad of frame is 117 of them. On
 * that reference 0.020 is 24 px across — the smallest a ring can be and still
 * read as a deliberate mark rather than dust on the monitor. Measured on the
 * deployed site, "Về ngắm cảnh từ trên cao" puts the camera 3,439 m out and a
 * companion's body at 0.43 px tall while the trip panel still reads "Bạn và 1
 * người nữa": a sprite that shrinks is no answer to that, one that does not is.
 */
const RING_SPAN = 0.02;
/**
 * Past this the ring stops growing. Beyond the diagonal of the largest terrain
 * (5,200 m square, so 7,354 m corner to corner) rather than at the 3,400 cut in
 * `poi-markers.ts`: four plaques at full range are four smudges fighting each
 * other, but a companion is one mark whose whole job is surviving the range.
 */
const RING_SPAN_CLAMP = 7400;

/**
 * Metres above a companion's feet: the chest of the rigged body (`TARGET_HEIGHT`
 * 1.78) and the middle of the stand-in cylinder (`PERSON_HEIGHT` 2.8), so it
 * marks the person under either, clear of the name label above the head.
 */
const RING_LIFT = 1.1;

/**
 * The window the ring fades up over, in metres of range.
 *
 * Measured: a freshly joined companion is 9–17 m away, 88 px tall, with a legible
 * name over their head. A marker on top of that points at something you are
 * already looking at, and the compass covers the case where they are behind you.
 * By 48 m the figure is about 34 px and the ring has something to add.
 */
const NEAR = 26;
const FULL = 48;

/**
 * The most the ring may be worth, and how much of it the dark takes back.
 *
 * Unlit, like the name label it sits under, so it costs the frame no light at
 * all: no additive beam, no emissive anywhere. That is the difference between a
 * companion and a waypoint — a waypoint is what you are looking for all trip and
 * earns `BEAM_PEAK = 0.22` of glow for it, while a friend on the next ridge does
 * not need a pillar of light and the highlight budget after dark belongs to the
 * lanterns. The night cut is on the tint, not the opacity, so the ring loses
 * brightness without losing its edges. `present-pass.ts` reads anything over
 * 0.12 scene-linear as a light rather than a surface; the brightest of these
 * hues is `#b4552f` at 0.45 linear and 0.55 of that is 0.25 — a lit mark at
 * midnight, well under the `#f2ece2` name label at 0.88 that already hangs over
 * every companion's head after dark.
 */
const PEAK = 0.9;
const NIGHT_DIM = 0.45;

/** How much of the opacity the breathing takes, so the eye catches it at range. */
const PULSE = 0.16;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * A ring with a dot in it, painted white so the sprite's tint can colour it per
 * person, with a near-black backing on every edge — the mark has to read against
 * a snowfield and against a night hillside, and one of those is coming.
 */
const paintRing = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext('2d');
  if (!context) return;

  context.clearRect(0, 0, RING, RING);
  const middle = RING / 2;
  const backing = 'rgba(8, 11, 20, 0.9)';

  // Four strokes, dark under light twice over. The two middle entries are a disc
  // rather than a ring: a circle of radius r stroked at width 2r fills to r.
  for (const [radius, width, paint] of [
    [25, 12, backing],
    [25, 7, '#ffffff'],
    [4.5, 9, backing],
    [3, 6, '#ffffff'],
  ] as const) {
    context.beginPath();
    context.arc(middle, middle, radius, 0, Math.PI * 2);
    context.lineWidth = width;
    context.strokeStyle = paint;
    context.stroke();
  }
};

type Slot = {
  sprite: Sprite;
  material: SpriteMaterial;
  /** Whose ring this is, so a roster change never moves anybody else's. */
  owner: string | null;
  /** The person's own colour, kept because the night tint is a fresh multiply. */
  hue: Color;
  at: Vector3;
  phase: number;
};

export type CompanionMarkers = {
  group: Group;
  /** Replace the whole roster, exactly as `avatars.sync` takes it. */
  sync: (players: RemotePlayer[]) => void;
  /** @param viewer the camera, since that is what decides how big a thing looks. */
  update: (elapsed: number, viewer?: { x: number; y?: number; z: number }) => void;
  /** @param amount 0 by day .. 1 at full dark. */
  setNight: (amount: number) => void;
  dispose: () => void;
};

/**
 * Where the people you came with are, when they are too far away to be people.
 *
 * The reported bug was two travellers in one room seeing nothing of each other.
 * The avatar turned out to render correctly — measured at 88 px with a legible
 * name — so the gap is not in the drawing but in the range: the body is a
 * fraction of a pixel from the sightseeing camera, and the name label, the one
 * element already drawn through terrain, shrinks with it until it is a smudge
 * among waypoint plaques that are deliberately larger. So: one sprite per
 * companion and nothing else. It holds its size on screen at any range, draws
 * through hills, carries the person's own colour rather than their name, and
 * fades out once you are close enough to see each other — which is the range the
 * compass covers instead. A waypoint is a destination and gets a mast, a beam
 * and a plaque; a friend gets a ring.
 */
export const createCompanionMarkers = (): CompanionMarkers => {
  const group = new Group();
  group.name = 'companion-markers';
  group.visible = false;

  const canvas = document.createElement('canvas');
  canvas.width = RING;
  canvas.height = RING;
  paintRing(canvas);
  const texture = new CanvasTexture(canvas);

  // Built once, up front, then shown and hidden. Somebody joining is a frame
  // like any other and must not be the frame that compiles a shader.
  const slots: Slot[] = [];
  for (let index = 0; index < MAX_MARKERS; index += 1) {
    const material = new SpriteMaterial({
      map: texture,
      transparent: true,
      // The whole point: the person you are looking for is behind the hill you
      // are walking over. The avatar's name label is drawn through walls for the
      // same reason; this is the mark that survives the range it does not.
      depthTest: false,
      opacity: 0,
    });
    const sprite = new Sprite(material);
    // Under the name label's 50, so a name is never covered by a ring, and over
    // the waypoint plaque's 48, because a person moves and a signpost does not.
    sprite.renderOrder = 49;
    sprite.frustumCulled = false;
    sprite.visible = false;

    group.add(sprite);
    // Phases spread so seven rings do not breathe in unison, which reads as a UI
    // animation rather than as seven people.
    slots.push({ sprite, material, owner: null, hue: new Color(), at: new Vector3(), phase: index * 0.9 });
  }

  let night = 0;

  const release = (slot: Slot) => {
    slot.owner = null;
    slot.sprite.visible = false;
    slot.material.opacity = 0;
  };

  return {
    group,
    sync: (players) => {
      // The same guard `avatars.ts` applies, for the same reason: a position that
      // is not a position goes into a Vector3 and never comes out, and a ring
      // pinned at NaN has stopped answering the question. Such a player is simply
      // not in the room yet, and the next snapshot is a tenth of a second away.
      const roster = players
        .filter((player) => Number.isFinite(player.x) && Number.isFinite(player.y) && Number.isFinite(player.z))
        .slice(0, MAX_MARKERS);

      for (const slot of slots) {
        if (slot.owner && !roster.some((player) => player.id === slot.owner)) release(slot);
      }

      let held = 0;
      for (const player of roster) {
        const slot = slots.find((candidate) => candidate.owner === player.id) ?? slots.find((c) => c.owner === null);
        if (!slot) continue;

        slot.owner = player.id;
        slot.hue.set(colourFor(player.id));
        slot.at.set(player.x, player.y + RING_LIFT, player.z);
        held += 1;
      }

      // Nobody to point at, nothing in the frame: the group costs the renderer
      // one `visible` test rather than seven sprites' worth of sorting.
      group.visible = held > 0;
    },
    setNight: (amount) => {
      night = clamp01(amount);
    },
    update: (elapsed, viewer) => {
      if (!group.visible) return;

      const dim = 1 - night * NIGHT_DIM;

      for (const slot of slots) {
        if (!slot.owner) continue;

        slot.sprite.position.copy(slot.at);

        if (!viewer) {
          slot.sprite.visible = false;
          continue;
        }

        const range = Math.hypot(viewer.x - slot.at.x, viewer.z - slot.at.z, (viewer.y ?? slot.at.y) - slot.at.y);
        const reach = clamp01((range - NEAR) / (FULL - NEAR));
        const opacity = PEAK * reach * (1 - PULSE + Math.sin(elapsed * 1.7 + slot.phase) * PULSE);

        slot.sprite.visible = opacity > 0.015;
        if (!slot.sprite.visible) continue;

        slot.material.opacity = opacity;
        slot.material.color.copy(slot.hue).multiplyScalar(dim);

        const span = RING_SPAN * Math.min(RING_SPAN_CLAMP, Math.max(NEAR, range));
        slot.sprite.scale.set(span, span, 1);
      }
    },
    dispose: () => {
      for (const slot of slots) slot.material.dispose();
      texture.dispose();
      group.clear();
    },
  };
};
