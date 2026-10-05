import type { LocationRecipe } from '@otrip/world';
import {
  Color,
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';

import { createGeometryKit, type KitGeometry } from './building-geometry';
import { createMaterialKit, type KitMaterial } from './building-materials';
import { createPanelKit, type PanelKit } from './building-panels';

/**
 * A town is tens of thousands of small parts, so nothing here is a mesh of its
 * own: a builder stamps shared unit geometry into a part list, and the whole
 * settlement then collapses into one InstancedMesh per geometry/material pair.
 * The cost of one more balcony is a matrix, not a draw call, which is what
 * makes it affordable to build a house properly.
 */

export type PutOptions = {
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** Uniform scale; per-axis sx/sy/sz override it. */
  size?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  /** Multiplies the material colour for this instance only. */
  tint?: Color;
};

export type BuildSink = {
  /** The workhorse: a unit cube scaled into a wall, beam, slab or panel. */
  box: (
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    yaw?: number
  ) => void;
  put: (
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
    options?: PutOptions
  ) => void;
  /** A nested frame: everything stamped through it is offset and rotated by this. */
  frame: (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => BuildSink;
};

type Part = { matrix: Matrix4; tint: Color | null };
type PartStore = Map<BufferGeometry, Map<MeshStandardMaterial, Part[]>>;

const localPosition = new Vector3();
const localRotation = new Quaternion();
const localScale = new Vector3();
const localEuler = new Euler(0, 0, 0, 'YXZ');
const localMatrix = new Matrix4();

/**
 * YXZ so the angles read as yaw-pitch-roll of the finished part: roll tips a
 * beam along its own length, pitch drops a roof slope, yaw turns the house.
 */
const compose = (
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
  sx: number,
  sy: number,
  sz: number
): Matrix4 => {
  localPosition.set(x, y, z);
  localEuler.set(pitch, yaw, roll);
  localRotation.setFromEuler(localEuler);
  localScale.set(sx, sy, sz);
  return localMatrix.compose(localPosition, localRotation, localScale);
};

const createSink = (store: PartStore, base: Matrix4, unitBox: BufferGeometry): BuildSink => {
  const emit = (geometry: BufferGeometry, material: MeshStandardMaterial, local: Matrix4, tint: Color | null) => {
    let byMaterial = store.get(geometry);
    if (!byMaterial) {
      byMaterial = new Map();
      store.set(geometry, byMaterial);
    }
    let parts = byMaterial.get(material);
    if (!parts) {
      parts = [];
      byMaterial.set(material, parts);
    }
    parts.push({ matrix: new Matrix4().multiplyMatrices(base, local), tint });
  };

  return {
    box: (material, x, y, z, sx, sy, sz, yaw = 0) => {
      emit(unitBox, material, compose(x, y, z, yaw, 0, 0, sx, sy, sz), null);
    },
    put: (geometry, material, x, y, z, options) => {
      const size = options?.size ?? 1;
      emit(
        geometry,
        material,
        compose(
          x,
          y,
          z,
          options?.yaw ?? 0,
          options?.pitch ?? 0,
          options?.roll ?? 0,
          options?.sx ?? size,
          options?.sy ?? size,
          options?.sz ?? size
        ),
        options?.tint ?? null
      );
    },
    frame: (x, y, z, yaw = 0, pitch = 0, roll = 0) =>
      createSink(store, new Matrix4().multiplyMatrices(base, compose(x, y, z, yaw, pitch, roll, 1, 1, 1)), unitBox),
  };
};

export type BuildingKit = {
  geo: KitGeometry;
  mat: KitMaterial;
  panel: PanelKit;
  tileField: (width: number, slope: number, taper?: number) => BufferGeometry;
  corrugated: (width: number, taper?: number) => BufferGeometry;
  /** The frame one building is stamped into: where it stands and which way it faces. */
  frame: (x: number, y: number, z: number, yaw: number) => BuildSink;
  /** Collapses everything stamped so far into one mesh per geometry/material. */
  assemble: () => InstancedMesh[];
  /** Hands the town's surfaces the rain's wetness. */
  setWet: (wet: { value: number }) => void;
  setNight: (amount: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
};

export const createBuildingKit = (recipe: LocationRecipe): BuildingKit => {
  const store: PartStore = new Map();
  const geometryKit = createGeometryKit();
  const materialKit = createMaterialKit(recipe);
  const panelKit = createPanelKit();
  const meshes: InstancedMesh[] = [];

  return {
    geo: geometryKit.geo,
    mat: materialKit.mat,
    panel: panelKit,
    tileField: geometryKit.tileField,
    corrugated: geometryKit.corrugated,
    frame: (x, y, z, yaw) => createSink(store, compose(x, y, z, yaw, 0, 0, 1, 1, 1).clone(), geometryKit.geo.box),
    assemble: () => {
      const white = new Color(1, 1, 1);

      for (const [geometry, byMaterial] of store) {
        for (const [material, parts] of byMaterial) {
          const mesh = new InstancedMesh(geometry, material, parts.length);
          const tinted = parts.some((part) => part.tint !== null);

          parts.forEach((part, index) => {
            mesh.setMatrixAt(index, part.matrix);
            if (tinted) mesh.setColorAt(index, part.tint ?? white);
          });

          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          // The instances span the whole settlement, so the base geometry's own
          // bounds would cull the town the moment the origin left the frustum.
          mesh.computeBoundingSphere();
          meshes.push(mesh);
        }
      }

      store.clear();
      return meshes;
    },
    setWet: materialKit.setWet,
    setNight: materialKit.setNight,
    update: materialKit.update,
    dispose: () => {
      for (const mesh of meshes) mesh.dispose();
      meshes.length = 0;
      store.clear();
      geometryKit.dispose();
      materialKit.dispose();
      panelKit.dispose();
    },
  };
};
