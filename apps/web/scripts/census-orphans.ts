/**
 * Modules nothing reaches.
 *
 * Three times in this project a file has been written, been correct, been
 * well-commented, and been missing only an import line — `world-map.tsx`,
 * `action-prompt.tsx` and `night-notice.tsx`. Nothing failed, nothing logged, and
 * the page rendered perfectly without them, which is exactly why each survived a
 * handover. A compiler cannot see it, and the census cannot either: the census
 * measures what it calls, and a module with no caller is never called.
 *
 * Reachability, not a reverse-import count. Counting importers finds a file that
 * nobody mentions, but two dead modules that import each other both have an
 * importer and both read as live — and a deleted call site leaves exactly that
 * shape behind, because the module it called still imports its own helpers. So
 * this walks outwards from the files the framework itself routes to and reports
 * everything the walk never arrives at.
 *
 * Specifiers are resolved against the importing file rather than matched on their
 * last segment, so two files with the same basename in different directories
 * cannot vouch for each other.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Filenames the framework routes to, so no source file imports them. */
const ENTRY_POINTS = new Set([
  'page',
  'layout',
  'route',
  'not-found',
  'middleware',
  'instrumentation',
  'opengraph-image',
  'twitter-image',
  'icon',
  'apple-icon',
  'sitemap',
  'robots',
  'manifest',
  'error',
  'global-error',
  'loading',
  'template',
  'default',
]);

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));

/** Extensions tried, in order, for a specifier that names a file or a directory. */
const SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
};

/** `from '…'`, `import('…')`, and the bare `import '…'` a side-effect module uses. */
const SPECIFIER = /(?:from\s*|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

const specifiersIn = (file: string): string[] => {
  const found: string[] = [];
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    if (spec) found.push(spec);
  }
  return found;
};

/**
 * A specifier to the file it names, or null for a bare package. `@/` is the
 * alias `tsconfig.json` maps to `src/`.
 */
const resolveSpecifier = (from: string, spec: string): string | null => {
  const base = spec.startsWith('@/')
    ? resolve(SOURCE, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null;
  if (base === null) return null;

  for (const suffix of SUFFIXES) {
    const path = base + suffix;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
};

export type OrphanReport = {
  scanned: number;
  entries: number;
  /** Reachable from no entry point. Dead, whether or not something imports it. */
  unreachable: string[];
  /** Of those, the ones no file mentions at all — the missing-import-line case. */
  unimported: string[];
};

export const findOrphans = (): OrphanReport => {
  const files = walk(SOURCE);
  const edges = new Map<string, string[]>();
  const mentioned = new Set<string>();

  for (const file of files) {
    const targets: string[] = [];
    for (const spec of specifiersIn(file)) {
      const target = resolveSpecifier(file, spec);
      // Self-imports exist in this tree (a module re-exporting its own types) and
      // must not let a file vouch for itself.
      if (target && target !== file) {
        targets.push(target);
        mentioned.add(target);
      }
    }
    edges.set(file, targets);
  }

  const entries = files.filter((file) =>
    ENTRY_POINTS.has(
      file
        .replace(/\.tsx?$/, '')
        .split('/')
        .pop()!
    )
  );

  const reached = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const target of edges.get(file) ?? []) queue.push(target);
  }

  const unreachable = files.filter((file) => !reached.has(file)).sort();
  return {
    scanned: files.length,
    entries: entries.length,
    unreachable: unreachable.map((file) => relative(SOURCE, file)),
    unimported: unreachable.filter((file) => !mentioned.has(file)).map((file) => relative(SOURCE, file)),
  };
};

/**
 * Prints the report and returns the lines a caller should treat as failures, so
 * the census can fold them into its own list rather than exiting here.
 */
export const reportOrphans = (): string[] => {
  const report = findOrphans();
  console.log(
    `\n=== imports ===\n${report.scanned} modules scanned from ${report.entries} framework entry points, ` +
      `${report.unreachable.length} reachable by nothing`
  );
  const failures: string[] = [];
  for (const file of report.unreachable) {
    const never = report.unimported.includes(file);
    console.log(`  ${file}  ${never ? '— nothing imports it at all' : '— imported only by something else dead'}`);
    failures.push(`src/${file}: không có đường nào từ entry point tới file này${never ? ' (không ai import)' : ''}`);
  }
  return failures;
};
