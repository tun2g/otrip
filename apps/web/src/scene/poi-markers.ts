import type { Terrain } from '@otrip/world';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Sprite,
  SpriteMaterial,
} from 'three';

import type { ResolvedPoi } from './points-of-interest';
import type { WorldWeather } from './weather-state';

const BEAM_HEIGHT = 170;
const RING_RADIUS = 26;
/**
 * The terrain is a 384-segment grid over five kilometres, so a cell is thirteen
 * metres and a flat disc buries half of itself in every slope. The band follows
 * the heightfield and this clears the error between the bilinear height and the
 * two triangles the ground is actually drawn with.
 */
const RING_LIFT = 0.8;

const MAST_HEIGHT = 24;
const BANNER_LENGTH = 11;
const BANNER_WIDTH = 1.9;

/**
 * Brightness is reserved after dark: every non-emissive surface sits well under
 * a hundred and only lamps and lit windows go above it. An additive beam that
 * out-glows the village lanterns destroys that hierarchy, so this is the most
 * the beam may ever add, before weather takes its cut.
 */
const BEAM_PEAK = 0.22;
/**
 * Emissive strength of the lamp at the masthead. Deliberately under the bloom
 * threshold of 1.75, so a waypoint reads as lit but never halos — the halo is
 * what the village keeps for itself.
 */
const LAMP_PEAK = 0.9;

const PLAQUE_WIDTH = 384;
const PLAQUE_HEIGHT = 128;
/**
 * Metres of plaque per metre of range. A sprite shrinks with distance, which is
 * exactly wrong for the one element that has to be readable from the far side of
 * the map, so it grows instead and holds roughly a hundred pixels at any range.
 */
const PLAQUE_SPAN = 0.098;

const PENDING = '#f2a679';
const VISITED = '#9ec7b0';
const INK = 'rgba(11, 16, 32, 0.84)';
const DAY_TEXT = '#f2ece2';
/** Paper this dark still clears 8:1 on the plaque's ink and stays under a lantern. */
const NIGHT_TEXT = '#9fb0c4';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Matches the wording on the world map, so one place reads the same in both. */
const formatDistance = (metres: number): string =>
  metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;

/**
 * A band of paint that follows the ground rather than a disc laid across it.
 * Positions are relative to the marker, heights absolute minus the marker's own,
 * so the mesh can sit at the point of interest and still hug a slope.
 */
const createRingBand = (terrain: Terrain, poi: ResolvedPoi, inner: number, outer: number): BufferGeometry => {
  const segments = 96;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const indices: number[] = [];

  for (let step = 0; step <= segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let edge = 0; edge < 2; edge += 1) {
      const radius = edge === 0 ? inner : outer;
      const x = poi.x + cos * radius;
      const z = poi.z + sin * radius;
      const at = (step * 2 + edge) * 3;

      positions[at] = cos * radius;
      positions[at + 1] = terrain.heightAt(x, z) + RING_LIFT - poi.y;
      positions[at + 2] = sin * radius;

      // Lit like the hillside it is painted on. A flat up-normal made the band
      // on a steep slope brighter than the ground either side of it.
      const slopeX = (terrain.heightAt(x + 2, z) - terrain.heightAt(x - 2, z)) / 4;
      const slopeZ = (terrain.heightAt(x, z + 2) - terrain.heightAt(x, z - 2)) / 4;
      const length = Math.hypot(slopeX, 1, slopeZ);
      normals[at] = -slopeX / length;
      normals[at + 1] = 1 / length;
      normals[at + 2] = -slopeZ / length;
    }

    if (step < segments) {
      const base = step * 2;
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
};

type PlaqueFace = { name: string; distance: string; accent: string; text: string };

const paintPlaque = (canvas: HTMLCanvasElement, face: PlaqueFace) => {
  const context = canvas.getContext('2d');
  if (!context) return;

  context.clearRect(0, 0, PLAQUE_WIDTH, PLAQUE_HEIGHT);

  const left = 8;
  const top = 6;
  const width = PLAQUE_WIDTH - left * 2;
  const height = 88;

  context.beginPath();
  context.roundRect(left, top, width, height, 16);
  context.fillStyle = INK;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = face.accent;
  context.stroke();

  // A tail under the plaque, so a sign hanging in the sky still reads as
  // belonging to the mast underneath it rather than floating on its own.
  context.beginPath();
  context.moveTo(PLAQUE_WIDTH / 2 - 11, top + height - 1);
  context.lineTo(PLAQUE_WIDTH / 2 + 11, top + height - 1);
  context.lineTo(PLAQUE_WIDTH / 2, top + height + 22);
  context.closePath();
  context.fillStyle = INK;
  context.fill();

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = face.text;
  context.font = '600 32px system-ui, sans-serif';
  context.fillText(face.name, PLAQUE_WIDTH / 2, top + (face.distance ? 32 : height / 2), width - 24);

  if (face.distance) {
    context.fillStyle = face.accent;
    context.font = '500 26px system-ui, sans-serif';
    context.fillText(face.distance, PLAQUE_WIDTH / 2, top + 66, width - 24);
  }
};

type Entry = {
  poi: ResolvedPoi;
  beam: Mesh;
  beamMaterial: MeshBasicMaterial;
  ringGeometry: BufferGeometry;
  ringMaterial: MeshStandardMaterial;
  bannerPivot: Group;
  bannerMaterial: MeshStandardMaterial;
  lampMaterial: MeshStandardMaterial;
  plaque: Sprite;
  plaqueCanvas: HTMLCanvasElement;
  plaqueTexture: CanvasTexture;
  plaqueMaterial: SpriteMaterial;
  /** What the plaque currently shows, so the canvas is only repainted on a change. */
  painted: string;
  phase: number;
  discovered: boolean;
};

export type PoiMarkers = {
  group: Group;
  setDiscovered: (ids: Set<string>) => void;
  /** @param amount 0 by day .. 1 at full dark. */
  setNight: (amount: number) => void;
  setWeather: (weather: WorldWeather) => void;
  /** @param viewer the camera, so the plaque can size itself and the beam get out of the way. */
  update: (elapsed: number, viewer?: { x: number; z: number; y?: number }) => void;
  dispose: () => void;
};

/**
 * Every place worth walking to, marked so you can find it. Without these the map
 * was beautiful and completely directionless — you could walk for a minute
 * without ever learning there was anything to walk towards.
 *
 * Three devices, because one cannot cover the range. A banner on a mast is the
 * marker you see across a field in full sun, where a glow is only haze. A plaque
 * that holds its size on screen carries the name and the metres, which is the
 * actual question — which way, and how far. The beam is for the dark, when the
 * other two are unlit cloth, and it is capped so the village stays the brightest
 * thing after sunset.
 */
export const createPoiMarkers = (pois: ResolvedPoi[], terrain: Terrain): PoiMarkers => {
  const group = new Group();
  group.name = 'poi-markers';

  // Thin on purpose. At six metres across these filled the screen the moment you
  // stood near one, which read as being trapped inside a building.
  const beamGeometry = new CylinderGeometry(1.5, 0.8, BEAM_HEIGHT, 7, 1, true);

  const mastGeometry = new CylinderGeometry(0.17, 0.34, MAST_HEIGHT, 7);
  mastGeometry.translate(0, MAST_HEIGHT / 2, 0);
  const finialGeometry = new ConeGeometry(0.4, 1.2, 7);
  finialGeometry.translate(0, MAST_HEIGHT + 0.6, 0);
  const lampGeometry = new CylinderGeometry(0.34, 0.4, 0.78, 8);
  lampGeometry.translate(0, MAST_HEIGHT - 2.2, 0);

  // Hung from its top corner at the mast, so the pivot can swing the whole cloth
  // downwind without the geometry having to move.
  const bannerGeometry = new PlaneGeometry(BANNER_WIDTH, BANNER_LENGTH);
  bannerGeometry.translate(BANNER_WIDTH / 2, -BANNER_LENGTH / 2, 0);
  const hemGeometry = new PlaneGeometry(BANNER_WIDTH, 0.6);
  hemGeometry.translate(BANNER_WIDTH / 2, -BANNER_LENGTH - 0.3, 0);

  const mastMaterial = new MeshStandardMaterial({ color: new Color('#2e2822'), roughness: 0.86, metalness: 0 });
  const finialMaterial = new MeshStandardMaterial({ color: new Color('#c8a05a'), roughness: 0.42, metalness: 0.5 });
  const hemMaterial = new MeshStandardMaterial({
    color: new Color('#1a1410'),
    roughness: 0.92,
    metalness: 0,
    side: DoubleSide,
  });

  const entries: Entry[] = pois.map((poi, index) => {
    const beamMaterial = new MeshBasicMaterial({
      color: new Color('#e8b88f'),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const beam = new Mesh(beamGeometry, beamMaterial);
    beam.position.set(poi.x, poi.y + BEAM_HEIGHT / 2, poi.z);
    beam.frustumCulled = false;
    beam.visible = false;

    const ringGeometry = createRingBand(terrain, poi, RING_RADIUS * 0.72, RING_RADIUS);
    const ringMaterial = new MeshStandardMaterial({
      color: new Color(PENDING),
      emissive: new Color(PENDING),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0.62,
      roughness: 0.78,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const ring = new Mesh(ringGeometry, ringMaterial);
    ring.position.set(poi.x, poi.y, poi.z);

    const mast = new Mesh(mastGeometry, mastMaterial);
    const finial = new Mesh(finialGeometry, finialMaterial);

    const lampMaterial = new MeshStandardMaterial({
      color: new Color('#3a2f28'),
      emissive: new Color('#ffc271'),
      emissiveIntensity: 0,
      roughness: 0.6,
      metalness: 0,
    });
    const lamp = new Mesh(lampGeometry, lampMaterial);

    const bannerMaterial = new MeshStandardMaterial({
      color: new Color(PENDING),
      emissive: new Color(PENDING),
      emissiveIntensity: 0,
      roughness: 0.9,
      metalness: 0,
      side: DoubleSide,
    });
    const bannerPivot = new Group();
    bannerPivot.position.y = MAST_HEIGHT - 1.3;
    bannerPivot.add(new Mesh(bannerGeometry, bannerMaterial), new Mesh(hemGeometry, hemMaterial));

    const post = new Group();
    post.position.set(poi.x, poi.y, poi.z);
    post.add(mast, finial, lamp, bannerPivot);

    const plaqueCanvas = document.createElement('canvas');
    plaqueCanvas.width = PLAQUE_WIDTH;
    plaqueCanvas.height = PLAQUE_HEIGHT;
    const plaqueTexture = new CanvasTexture(plaqueCanvas);
    const plaqueMaterial = new SpriteMaterial({
      map: plaqueTexture,
      transparent: true,
      // The place you are walking to is often behind the hill you are walking
      // over. Hiding the one element that says how far would defeat it.
      depthTest: false,
      opacity: 0,
    });
    const plaque = new Sprite(plaqueMaterial);
    plaque.position.set(poi.x, poi.y + MAST_HEIGHT + 6, poi.z);
    plaque.renderOrder = 48;
    plaque.visible = false;

    group.add(beam, ring, post, plaque);

    return {
      poi,
      beam,
      beamMaterial,
      ringGeometry,
      ringMaterial,
      bannerPivot,
      bannerMaterial,
      lampMaterial,
      plaque,
      plaqueCanvas,
      plaqueTexture,
      plaqueMaterial,
      painted: '',
      phase: index * 1.7,
      discovered: false,
    };
  });

  let night = 0;
  let rain = 0;
  let occlusion = 0;
  let windSpeed = 8;
  let windFrom = (120 * Math.PI) / 180;

  /** Everything that depends on the hour and the sky but not on where you stand. */
  const applyLook = () => {
    // Haze eats a shaft of light long before it eats a painted sign, so the beam
    // takes the deeper cut of the two.
    const air = (1 - rain * 0.55) * (1 - occlusion * 0.4);

    for (const entry of entries) {
      const muted = entry.discovered ? 0.4 : 1;
      entry.ringMaterial.emissiveIntensity = night * 0.22 * air * muted;
      entry.lampMaterial.emissiveIntensity = night * LAMP_PEAK * (1 - rain * 0.35) * muted;
      // Cloth near a lamp is not black at midnight, but it is close.
      entry.bannerMaterial.emissiveIntensity = night * 0.1 * muted;
    }
  };

  const setDiscovered = (ids: Set<string>) => {
    for (const entry of entries) {
      entry.discovered = ids.has(entry.poi.id);
      const colour = entry.discovered ? VISITED : PENDING;
      entry.beamMaterial.color.set(colour);
      entry.ringMaterial.color.set(colour);
      entry.ringMaterial.emissive.set(colour);
      entry.ringMaterial.opacity = entry.discovered ? 0.3 : 0.62;
      entry.bannerMaterial.color.set(colour);
      entry.bannerMaterial.emissive.set(colour);
      // Force the plaque to repaint in the new colour.
      entry.painted = '';
    }
    applyLook();
  };

  const dayText = new Color(DAY_TEXT);
  const nightText = new Color(NIGHT_TEXT);
  const scratch = new Color();

  return {
    group,
    setDiscovered,
    setNight: (amount) => {
      night = clamp01(amount);
      applyLook();
    },
    setWeather: (weather) => {
      rain = clamp01(weather.rainIntensity);
      occlusion = clamp01(weather.skyOcclusion);
      windSpeed = Math.max(0, weather.windSpeed);
      windFrom = (weather.windDirection * Math.PI) / 180;
      applyLook();
    },
    update: (elapsed, viewer) => {
      const pulse = 0.76 + Math.sin(elapsed * 1.6) * 0.24;
      const air = (1 - rain * 0.55) * (1 - occlusion * 0.4);
      const beamStrength = BEAM_PEAK * night * air;
      const gust = Math.min(1, windSpeed / 55);
      // A banner in wind lifts toward the side it hangs on, and the pivot points
      // that side downwind: north is -Z, so a wind FROM `windFrom` blows towards
      // (-sin, +cos), which a group reaches by turning -windFrom - 90°.
      const aim = -windFrom - Math.PI / 2;

      for (const entry of entries) {
        entry.bannerPivot.rotation.y = aim + Math.sin(elapsed * (0.5 + gust) + entry.phase) * (0.1 + gust * 0.42);
        entry.bannerPivot.rotation.z = gust * 0.5 + Math.sin(elapsed * (1.1 + gust * 1.4) + entry.phase) * 0.07;

        const range = viewer
          ? Math.hypot(viewer.x - entry.poi.x, viewer.z - entry.poi.z, (viewer.y ?? entry.poi.y) - entry.poi.y)
          : 0;

        // A beam is a signpost seen from a distance. Close up it is just a wall
        // of light in the way, so it fades out as you arrive — by which point
        // the ring on the ground is telling you the same thing.
        const near = viewer ? Math.min(1, Math.max(0, (range - 25) / 55)) : 1;
        const opacity = beamStrength * (0.72 + pulse * 0.28) * near * (entry.discovered ? 0.3 : 1);
        entry.beamMaterial.opacity = opacity;
        entry.beam.visible = opacity > 0.012;

        entry.ringMaterial.opacity = entry.discovered ? 0.3 : 0.5 + pulse * 0.14;

        if (!viewer) {
          entry.plaque.visible = false;
          continue;
        }

        // Arrived, or so far off that four plaques would be four smudges.
        const fade =
          Math.min(1, Math.max(0, (range - 45) / 35)) *
          Math.min(1, Math.max(0, (3400 - range) / 400)) *
          (entry.discovered ? 0.4 : 1);
        entry.plaque.visible = fade > 0.02;
        if (!entry.plaque.visible) continue;

        entry.plaqueMaterial.opacity = fade;
        const span = PLAQUE_SPAN * Math.min(3400, Math.max(50, range));
        entry.plaque.scale.set(span, (span * PLAQUE_HEIGHT) / PLAQUE_WIDTH, 1);

        const distance = formatDistance(range);
        const key = `${distance}|${Math.round(night * 8)}`;
        if (key !== entry.painted) {
          entry.painted = key;
          paintPlaque(entry.plaqueCanvas, {
            name: entry.poi.name,
            distance,
            accent: entry.discovered ? VISITED : PENDING,
            text: scratch.copy(dayText).lerp(nightText, night).getStyle(),
          });
          entry.plaqueTexture.needsUpdate = true;
        }
      }
    },
    dispose: () => {
      beamGeometry.dispose();
      mastGeometry.dispose();
      finialGeometry.dispose();
      lampGeometry.dispose();
      bannerGeometry.dispose();
      hemGeometry.dispose();
      mastMaterial.dispose();
      finialMaterial.dispose();
      hemMaterial.dispose();

      for (const entry of entries) {
        entry.ringGeometry.dispose();
        entry.beamMaterial.dispose();
        entry.ringMaterial.dispose();
        entry.bannerMaterial.dispose();
        entry.lampMaterial.dispose();
        entry.plaqueTexture.dispose();
        entry.plaqueMaterial.dispose();
      }

      group.clear();
    },
  };
};
