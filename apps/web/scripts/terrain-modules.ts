import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + extension)) return nextResolve(pathToFileURL(base + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createTerrain, LOCATION_SLUGS, LOCATIONS } = await import('@otrip/world');
const { createTownMeshes } = await import('../src/scene/town-meshes.ts');
const { createRoadNetwork } = await import('../src/scene/road-network.ts');
const { createDock, findDockSite } = await import('../src/scene/dock.ts');
const { resolvePois } = await import('../src/scene/points-of-interest.ts');

for (const slug of LOCATION_SLUGS) {
  const recipe = LOCATIONS[slug];
  const terrain = createTerrain(recipe, 560);
  const town = createTownMeshes(terrain, recipe, { density: 1 });
  const landing = findDockSite(terrain, recipe, town.buildings);
  const pois = resolvePois(terrain, recipe, town.buildings, landing);
  const roads = createRoadNetwork(terrain, recipe, pois, town.buildings);
  const dock = createDock(terrain, recipe, landing);
  console.log(
    `${slug.padEnd(10)} town buildings=${String(town.buildings.length).padStart(3)}  roads=${String(roads.roads.length).padStart(2)} parking=${roads.parking.length}  dock=${dock ? `moorings=${dock.moorings.length} exits=${dock.exits.length}` : 'null'}`
  );
  town.dispose();
  roads.dispose();
  dock?.dispose();
}
