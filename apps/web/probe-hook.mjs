import { registerHooks } from 'node:module';

// The scene imports its siblings without extensions, the way a bundler resolves
// them. Node does not, so the probe teaches it to.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through to the real specifier */
      }
    }
    return nextResolve(specifier, context);
  },
});
