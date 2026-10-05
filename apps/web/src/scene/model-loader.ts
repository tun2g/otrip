import type { BufferGeometry, Material } from 'three';
import { Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type MeshSource = {
  geometry: BufferGeometry;
  material: Material;
  /** Height of the model in its own units, so callers can scale to metres. */
  height: number;
};

const cache = new Map<string, Promise<MeshSource>>();

/**
 * Pulls one instanceable mesh out of a GLB. The nature kit is a single mesh per
 * file with a handful of vertices, so the node transform is baked into the
 * geometry and the result can be dropped straight into an InstancedMesh.
 */
const loadSource = (url: string): Promise<MeshSource> => {
  const existing = cache.get(url);
  if (existing) return existing;

  const promise = new Promise<MeshSource>((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        let found: Mesh | null = null;
        gltf.scene.updateWorldMatrix(true, true);
        gltf.scene.traverse((node) => {
          if (!found && node instanceof Mesh) found = node;
        });

        if (!found) {
          reject(new Error(`Không tìm thấy mesh trong ${url}`));
          return;
        }

        const mesh = found as Mesh;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.computeVertexNormals();

        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const height = box ? Math.max(0.001, box.max.y - box.min.y) : 1;

        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        resolve({ geometry, material, height });
      },
      undefined,
      (cause) => reject(cause instanceof Error ? cause : new Error(`Không tải được ${url}`))
    );
  });

  cache.set(url, promise);
  return promise;
};

export type NatureSources = Map<string, MeshSource>;

/**
 * Everything the scene scatters, fetched once and shared by every destination.
 * Four hundred kilobytes for the whole kit, so it is loaded before the first
 * frame rather than popping in afterwards.
 */
export const loadNature = async (names: string[]): Promise<NatureSources> => {
  const entries = await Promise.all(
    names.map(async (name) => [name, await loadSource(`/models/nature/${name}.glb`)] as const)
  );

  return new Map(entries);
};
