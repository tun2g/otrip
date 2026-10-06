import type { Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
} from 'three';

import { buildRaceKit, GLYPH, paintPennant } from './race-kit';
import type { RacePhase } from './race';
import type { RaceRoute } from './race-route';

/**
 * What somebody carried out of a van for the afternoon, and will carry home.
 *
 * `race-route.ts` lays the route on the carriageway the destination already has,
 * and this is everything that goes on it: cones at each station, a ribbon at the
 * line, a marshal with a flag, one flag at the checkpoint being driven at, and a
 * mast at the turn. Nothing bolted down, no arch, no paint — racing is a side
 * errand at four places people open to breathe in, and permanent race furniture
 * on the Tà Xùa ridge would be a worse thing than no race at all. `race-kit.ts`
 * builds it and works out where it stands; this is only what it then does,
 * hidden until a race exists, built once rather than in the frame one starts,
 * allocating nothing per frame.
 */

const BEAM_HEIGHT = 70;
/**
 * Most the flag's beam may add, by day and at full dark.
 *
 * `poi-markers.ts` runs its waypoint beam at 0.22 and its masthead lamp at 0.9,
 * both deliberately under the bloom threshold of 1.75: the frame's whole
 * highlight budget after sunset belongs to the lamps, and a marker that
 * out-glows the Hội An lanterns destroys the hierarchy `present-pass.ts` is
 * built on. A waypoint is what you look for all trip, a checkpoint is forty
 * seconds away, so this is quieter than either — and the day term exists because
 * the course has to be navigable at noon, when an additive column is nothing.
 */
const BEAM_DAY = 0.05;
const BEAM_NIGHT = 0.09;
/** The turn's beam against the flag's: half, because the flag is the instruction
 *  and the turn is only the end of the leg. */
const TURN_BEAM = 0.5;
/** Range over which an arrived-at beam fades out: close up it is a wall of light
 *  in the way, and the cones say the same thing by then. */
const BEAM_NEAR = 18;
const BEAM_FULL = 58;
/** Emissive on the kit after dark, under `poi-markers`' 0.22 ring on purpose: a
 *  cone is not a light, it is pale paint picking the night up. */
const KIT_GLOW = 0.08;

/**
 * Metres of pennant per metre of range, and the most it is drawn at. A sprite
 * shrinks with distance, which is wrong for the one mark that says which way:
 * `poi-markers`' plaque grows instead and holds about a hundred pixels at 0.098.
 * A third of that is roughly thirty-five — a mark you follow, not a sign you
 * read. The lap, the gap and the order are in the HUD, so this carries no text.
 */
const SPRITE_SPAN = 0.033;
const SPRITE_PEAK = 0.8;
const SPRITE_NEAR = 70;
const SPRITE_FAR = 1100;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const approach = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * Math.min(1, rate * dt);

export type RaceMarkers = {
  group: Group;
  setPhase: (phase: RacePhase) => void;
  /** 0..1, how far through the countdown. The caller owns the clock. */
  setCountdown: (fraction: number) => void;
  /** Which checkpoint the local player is driving at, so only that one is flagged. */
  setTarget: (checkIndex: number) => void;
  setNight: (amount: number) => void;
  update: (elapsed: number, viewer?: { x: number; z: number }) => void;
  dispose: () => void;
};

export const createRaceMarkers = (route: RaceRoute, terrain: Terrain): RaceMarkers => {
  const group = new Group();
  group.name = 'race-markers';
  group.visible = false;

  const kit = buildRaceKit(route, terrain);
  const lastStation = route.stations.length - 1;

  // One material for every piece of kit: it is all vertex-coloured out of
  // `mergeParts`, so cones, posts, tape, both flags and the marshal share a
  // shader and the whole course is a handful of draw calls.
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.74,
    metalness: 0,
    emissive: new Color('#cfd8e4'),
    emissiveIntensity: 0,
  });
  if (kit.stand) {
    const stand = new Mesh(kit.stand, material);
    stand.name = 'kit';
    group.add(stand);
  }

  // Strung between the posts while the field is on the grid, unhooked from the
  // far one and left hanging once the race is away. The ceremonial piece,
  // because a finish line is.
  const ribbonPivot = new Group();
  ribbonPivot.name = 'ribbon';
  ribbonPivot.position.set(kit.ribbonAt.x, kit.ribbonAt.y, kit.ribbonAt.z);
  ribbonPivot.rotation.y = kit.ribbonAt.yaw;
  if (kit.ribbon) ribbonPivot.add(new Mesh(kit.ribbon, material));

  const starterPivot = new Group();
  starterPivot.name = 'starter';
  starterPivot.position.set(kit.marshalAt.x, kit.marshalAt.y, kit.marshalAt.z);
  starterPivot.rotation.y = kit.marshalAt.yaw;
  if (kit.starter) starterPivot.add(new Mesh(kit.starter, material));

  // One flag, moved to the checkpoint being driven at. A flag on every station
  // is a slalom; a flag on the next one is a direction, and it is most of the
  // course navigation there is.
  const flagGroup = new Group();
  flagGroup.name = 'flag';
  const mast = kit.mast ? new Mesh(kit.mast, material) : null;
  const clothPivot = new Group();
  if (kit.cloth) clothPivot.add(new Mesh(kit.cloth, material));
  if (mast) flagGroup.add(mast);
  flagGroup.add(clothPivot);
  group.add(ribbonPivot, starterPivot, flagGroup);

  const beamGeometry = new CylinderGeometry(0.55, 0.3, BEAM_HEIGHT, 6, 1, true);
  const makeBeam = (name: string) => {
    const beamMaterial = new MeshBasicMaterial({
      color: new Color('#ffd890'),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(beamGeometry, beamMaterial);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.visible = false;
    group.add(mesh);
    return { mesh, material: beamMaterial };
  };
  const flagBeam = makeBeam('flag-beam');
  const turnBeam = makeBeam('turn-beam');
  turnBeam.mesh.position.set(kit.turnAt.x, kit.turnAt.y + BEAM_HEIGHT / 2, kit.turnAt.z);

  const glyph = document.createElement('canvas');
  glyph.width = GLYPH;
  glyph.height = GLYPH;
  paintPennant(glyph);
  const glyphTexture = new CanvasTexture(glyph);
  const spriteMaterial = new SpriteMaterial({
    map: glyphTexture,
    transparent: true,
    // The next checkpoint is regularly behind the bend being taken to reach it.
    // Hiding the one mark that says which way defeats the point of it.
    depthTest: false,
    opacity: 0,
  });
  const sprite = new Sprite(spriteMaterial);
  sprite.name = 'pennant';
  sprite.renderOrder = 40;
  sprite.visible = false;
  group.add(sprite);

  let phase: RacePhase = 'idle';
  let countdown = 0;
  let night = 0;
  let unhooked = 0;
  let raised = 0;
  let flagYaw = kit.yaws[0];
  let station = -1;
  let last = 0;

  const setTarget = (checkIndex: number) => {
    const next = route.checks[checkIndex]?.station ?? 0;
    if (next === station) return;
    station = next;
    const at = kit.flagsAt[next];
    flagGroup.position.set(at.x, at.y, at.z);
    // The mast is a unit cylinder, so the length its plant asked for is a scale
    // rather than a rebuild — no geometry is made after this module is created.
    if (mast) mast.scale.y = at.length;
    clothPivot.position.y = at.length - 0.12;
    flagYaw = kit.yaws[next];
    flagBeam.mesh.position.set(at.x, at.y + BEAM_HEIGHT / 2, at.z);
    sprite.position.set(at.x, at.y + at.length + 0.5, at.z);
  };
  setTarget(0);

  return {
    group,
    setPhase: (next) => {
      phase = next;
      group.visible = next !== 'idle';
      if (next !== 'idle') return;
      // Packed away, so the next race opens on a strung ribbon.
      unhooked = 0;
      raised = 0;
      countdown = 0;
    },
    setCountdown: (fraction) => {
      countdown = clamp01(fraction);
    },
    setTarget,
    setNight: (amount) => {
      night = clamp01(amount);
      material.emissiveIntensity = night * KIT_GLOW;
    },
    update: (elapsed, viewer) => {
      // The caller owns the clock and hands over only `elapsed`, so the step is
      // the difference — clamped, because the first call carries all of it.
      const dt = Math.min(0.12, Math.max(0, elapsed - last));
      last = elapsed;
      // Hidden, so there is nothing to animate and no beam to fade. Keeping the
      // clock current is what stops the first visible frame arriving with a step
      // the length of the whole session.
      if (!group.visible) return;

      const away = phase === 'running' || phase === 'ended';
      unhooked = approach(unhooked, away ? 1 : 0, 2.4, dt);
      // Down at rest, up by the end of the countdown, swept down on the green and
      // up at the finish. The pivot is the shoulder, so the rotation is the arm.
      raised = approach(raised, phase === 'countdown' ? countdown : phase === 'ended' ? 1 : 0, 7, dt);

      // Taut, the tape only breathes; unhooked, it swings against the post it is
      // still tied to.
      ribbonPivot.rotation.z = -unhooked * 1.46 + Math.sin(elapsed * 0.8) * (0.012 + unhooked * 0.05);
      starterPivot.rotation.z = -1 + raised * 1.5;

      clothPivot.rotation.y = flagYaw + Math.sin(elapsed * 1.7) * 0.22;
      clothPivot.rotation.z = -0.12 + Math.sin(elapsed * 2.3) * 0.06;

      const range = viewer ? Math.hypot(viewer.x - flagGroup.position.x, viewer.z - flagGroup.position.z) : 400;
      const pulse = 0.82 + Math.sin(elapsed * 1.5) * 0.18;
      const peak = BEAM_DAY + BEAM_NIGHT * night;

      const beam = peak * pulse * clamp01((range - BEAM_NEAR) / BEAM_FULL);
      flagBeam.material.opacity = beam;
      flagBeam.mesh.visible = beam > 0.008;
      // Nothing to add when the flag is already standing at the turn.
      const far = station === lastStation ? 0 : peak * TURN_BEAM * pulse;
      turnBeam.material.opacity = far;
      turnBeam.mesh.visible = far > 0.008;

      const fade =
        SPRITE_PEAK *
        clamp01((range - SPRITE_NEAR) / 70) *
        // Dimmer after dark for the reason the beam is capped: a lantern outranks
        // a checkpoint.
        clamp01((SPRITE_FAR - range) / 200) *
        (1 - night * 0.35);
      sprite.visible = fade > 0.02;
      if (!sprite.visible) return;
      spriteMaterial.opacity = fade;
      const span = SPRITE_SPAN * Math.min(SPRITE_FAR, range);
      sprite.scale.set(span, span, 1);
    },
    dispose: () => {
      kit.stand?.dispose();
      kit.ribbon?.dispose();
      kit.starter?.dispose();
      kit.mast?.dispose();
      kit.cloth?.dispose();
      beamGeometry.dispose();
      material.dispose();
      flagBeam.material.dispose();
      turnBeam.material.dispose();
      spriteMaterial.dispose();
      glyphTexture.dispose();
      group.clear();
    },
  };
};
