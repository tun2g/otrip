import { pathToFileURL } from 'node:url';

const ROOT = pathToFileURL('/Users/macbook/Documents/self/otrip/apps/web/src/').href;
const WORLD = pathToFileURL('/Users/macbook/Documents/self/otrip/packages/world/src/index.ts').href;

export const resolve = (specifier, context, next) => {
  if (specifier.startsWith('@/')) return next(ROOT + specifier.slice(2) + '.ts', context);
  if (specifier === '@otrip/world') return next(WORLD, context);
  return next(specifier, context);
};
