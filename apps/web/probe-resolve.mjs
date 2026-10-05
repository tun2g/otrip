import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Another agent's town-meshes.ts now imports './building-kit' as a value, and
// Node has no extensionless resolution. Append .ts for relative specifiers.
export const resolve = async (specifier, context, next) => {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(specifier + '.ts', context);
    } catch {
      // fall through to the default resolver
    }
  }
  return next(specifier, context);
};
