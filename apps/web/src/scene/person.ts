import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  MeshStandardMaterial,
  Vector2,
} from 'three';

/**
 * A person is a cylinder under a cone — a body and a nón lá. Built from
 * primitives for the same reason the mountains are: nothing to download, one
 * consistent look, and the multiplayer avatars are literally this shape, so a
 * stranger walking past is made of the same two meshes as the villagers.
 *
 * Slightly over scale on purpose. A true 1.7m figure is sub-pixel on a map four
 * kilometres across, and an empty-looking town was the problem being solved.
 */
export const PERSON_HEIGHT = 2.8;

export type PersonParts = {
  body: BufferGeometry;
  hat: BufferGeometry;
  dispose: () => void;
};

export const createPersonParts = (): PersonParts => {
  const body = new CylinderGeometry(0.42, 0.52, PERSON_HEIGHT * 0.72, 6);
  body.translate(0, (PERSON_HEIGHT * 0.72) / 2, 0);

  const hat = new ConeGeometry(0.95, PERSON_HEIGHT * 0.26, 7);
  hat.translate(0, PERSON_HEIGHT * 0.72 + (PERSON_HEIGHT * 0.26) / 2, 0);

  return {
    body,
    hat,
    dispose: () => {
      body.dispose();
      hat.dispose();
    },
  };
};

/**
 * A nón lá for a figure built at real scale — the rigged human rather than the
 * over-scale stylised one, which carries the cone above instead. Turned, not
 * coned: a real one is a shallow dish whose brim turns back on itself, and that
 * returning lip is what keeps an edge against a bright sky. Metres, for a 1.78 m
 * person, so a 46 cm brim.
 */
export const createConicalHat = (): BufferGeometry =>
  new LatheGeometry(
    [
      new Vector2(0, 0.145),
      new Vector2(0.045, 0.133),
      new Vector2(0.09, 0.112),
      new Vector2(0.135, 0.084),
      new Vector2(0.18, 0.048),
      new Vector2(0.215, 0.012),
      new Vector2(0.23, 0),
      new Vector2(0.232, 0.007),
    ],
    14
  );

export type PersonMeshes = {
  body: InstancedMesh;
  hat: InstancedMesh;
  dispose: () => void;
};

export const createPersonMeshes = (
  parts: PersonParts,
  count: number,
  bodyColor: string,
  hatColor: string
): PersonMeshes => {
  const bodyMaterial = new MeshStandardMaterial({
    color: new Color(bodyColor),
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  });
  const hatMaterial = new MeshStandardMaterial({
    color: new Color(hatColor),
    flatShading: true,
    roughness: 0.92,
    metalness: 0,
  });

  const body = new InstancedMesh(parts.body, bodyMaterial, count);
  const hat = new InstancedMesh(parts.hat, hatMaterial, count);
  body.frustumCulled = false;
  hat.frustumCulled = false;

  return {
    body,
    hat,
    dispose: () => {
      bodyMaterial.dispose();
      hatMaterial.dispose();
      body.dispose();
      hat.dispose();
    },
  };
};
