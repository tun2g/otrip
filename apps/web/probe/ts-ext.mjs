import { pathToFileURL } from 'node:url';
const SRC = pathToFileURL('/Users/macbook/Documents/self/otrip/apps/web/src/').href;
export async function resolve(specifier, context, next) {
  let spec = specifier;
  if (spec.startsWith('@/')) spec = SRC + spec.slice(2);
  try {
    return await next(spec, context);
  } catch (cause) {
    if (!/\.[a-zA-Z0-9]+$/.test(spec)) {
      try { return await next(spec + '.ts', context); } catch { return next(spec + '/index.ts', context); }
    }
    throw cause;
  }
}
