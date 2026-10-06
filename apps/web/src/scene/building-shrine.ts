import type { BuildSink, BuildingKit } from './building-kit';
import { addIncenseUrn, addLantern } from './building-props';
import { addHipRoof } from './building-roof';
import type { Builder } from './building-spec';
import { addPlinth } from './building-walls';

/**
 * Miếu. The thing at the edge of a hamlet.
 *
 * Every settlement the generator builds away from the hub had nothing at its
 * centre: `SETTLEMENTS` gives the first plan of each style an đình, a chùa or a
 * nhà rông and gives every outlying plan `landmark: null`, so the four to eleven
 * other hamlets on each map were houses and a drying yard. A player who walked
 * out to one arrived at a cluster of buildings with nothing in it, which is the
 * difference between somewhere and some houses.
 *
 * A miếu rather than a second đình, for two reasons that are both about what is
 * really there. One is register: an đình is the hall of a whole làng and there is
 * one, while a miếu is the shrine a hamlet, a bend in the lane or a big tree has
 * — there are thousands and they are the most common built thing in the
 * Vietnamese landscape after the house. The other is ground: `PLOT.dinh` wants
 * 14 by 18 m at a gradient under 0.28 and would be refused on most of the Tà Xùa
 * ridge, where the whole point is that there is somewhere to arrive.
 *
 * The silhouette is the eave, not the wall. A miếu is a chest-high masonry box
 * under a tiled roof far too big for it, and getting that ratio wrong is what
 * makes a model of one read as a bus shelter — so the shrine is a little over
 * two metres wide inside a footprint that is mostly forecourt, and the roof
 * reaches 0.95 m past it on every side.
 */
export const buildShrine: Builder = (sink, kit, spec) => {
  const { width, depth, random } = spec;

  const shrineWidth = Math.min(width * 0.56, 2.4);
  const shrineDepth = Math.min(depth * 0.42, 2.1);
  const plinthY = 0.44;
  // `addHipRoof` drops the eave `eave * tan(pitch)` below the wall head, which
  // on a building this low is the number that decides whether it reads as a
  // miếu or as a bus shelter: the first pass took a 1.5 m wall with a 0.95 m
  // eave at 0.86 rad and put the eave line at 0.83 m — under the altar slab.
  // 1.9 m of wall, 0.55 m of overhang and the đình's own pitch leave the eave
  // at 1.86 m and the ridge at 3.25 m, so the roof is taller than the wall it
  // sits on, which is the whole silhouette.
  const wallTop = plinthY + 1.9;
  // Set back against the rear of the plot, so what the lane sees is the sân.
  const shrineZ = -depth / 2 + shrineDepth / 2 + 0.9;
  const shrine = sink.frame(0, 0, shrineZ);

  addPlinth(shrine, kit, shrineWidth + 1.3, shrineDepth + 1.3, plinthY, spec.drop, kit.mat.stone);
  shrine.box(kit.mat.paving, 0, plinthY - 0.05, 0, shrineWidth + 1.3, 0.1, shrineDepth + 1.3);
  shrine.put(kit.panel.steps(2), kit.mat.stone, 0, 0, shrineDepth / 2 + 1.05, {
    sx: shrineWidth * 0.7,
    sy: plinthY,
    sz: 0.9,
    yaw: Math.PI,
  });

  // Three walls and an open front. The jambs stand proud of the opening, which
  // is the whole of the façade on a building this small.
  const wall = random() < 0.55 ? kit.mat.whitewash : kit.mat.ochreDeep;
  const height = wallTop - plinthY;
  shrine.box(wall, 0, plinthY + height / 2, -shrineDepth / 2, shrineWidth, height, 0.24);
  for (const side of [-1, 1]) {
    shrine.box(wall, (side * shrineWidth) / 2, plinthY + height / 2, 0, 0.24, height, shrineDepth);
    shrine.box(wall, (side * shrineWidth) / 2.9, plinthY + height / 2, shrineDepth / 2, 0.42, height, 0.24);
  }
  // Lintel over the opening, with the name board under it.
  shrine.box(wall, 0, wallTop - 0.3, shrineDepth / 2, shrineWidth, 0.6, 0.24);
  shrine.box(kit.mat.lacquer, 0, wallTop - 0.34, shrineDepth / 2 + 0.14, shrineWidth * 0.62, 0.3, 0.05);
  shrine.box(kit.mat.gold, 0, wallTop - 0.34, shrineDepth / 2 + 0.18, shrineWidth * 0.5, 0.17, 0.02);

  // Hương án: the altar slab inside, on two stone legs, and the urn on it.
  const altarY = plinthY + 0.62;
  for (const side of [-1, 1]) {
    shrine.box(kit.mat.stone, (side * shrineWidth) / 3.4, plinthY + 0.31, -shrineDepth * 0.12, 0.2, 0.62, 0.5);
  }
  shrine.box(kit.mat.stone, 0, altarY, -shrineDepth * 0.12, shrineWidth * 0.78, 0.12, shrineDepth * 0.5);
  addIncenseUrn(shrine, kit, 0, altarY + 0.06, -shrineDepth * 0.12, 0.44);

  const roof = addHipRoof(shrine, kit, {
    width: shrineWidth + 0.3,
    depth: shrineDepth + 0.3,
    wallTop,
    pitch: 0.72,
    eave: 0.55,
    tile: random() < 0.5 ? kit.mat.tileOld : kit.mat.tileDark,
    timber: kit.mat.timberDark,
    horns: true,
  });

  for (const side of [-1, 1]) {
    addLantern(shrine, kit, (side * shrineWidth) / 2, roof.eaveY - 0.52, shrineDepth / 2 + 0.6, 0.32, false, 0.26);
  }

  // Trụ cổng: two pillars at the mouth of the forecourt with a lotus bud on top.
  // A miếu almost always has them, and they are what tells you from fifty metres
  // away that the small thing under the trees is a shrine and not a shed.
  const courtZ = shrineZ + shrineDepth / 2 + 0.9;
  const courtDepth = Math.max(1.4, depth - shrineDepth - 2.4);
  sink.box(kit.mat.paving, 0, 0.05, courtZ + courtDepth / 2, width * 0.72, 0.1, courtDepth);
  for (const side of [-1, 1]) {
    const x = (side * width * 0.58) / 2;
    const z = courtZ + courtDepth - 0.2;
    sink.box(kit.mat.whitewash, x, 0.95, z, 0.3, 1.9, 0.3);
    sink.box(kit.mat.stone, x, 1.93, z, 0.42, 0.14, 0.42);
    sink.put(kit.geo.bell, kit.mat.stone, x, 2.16, z, { sx: 0.3, sy: 0.42, sz: 0.3 });
    // A low wall from each pillar back toward the plinth, which is what makes
    // the forecourt a sân rather than a patch of paving.
    sink.box(kit.mat.whitewash, x, 0.3, courtZ + courtDepth * 0.42, 0.22, 0.6, courtDepth * 0.5);
  }
  addIncenseUrn(sink, kit, width * 0.19, 0.1, courtZ + courtDepth * 0.5, 0.78);

  return roof.ridgeY;
};
