import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next writes AGENTS.md / CLAUDE.md into the tree on every dev run; this
  // project keeps its instructions in .claude/rules instead.
  agentRules: false,
  // Source-only workspace packages — Next compiles them with the app.
  transpilePackages: ['@otrip/contracts', '@otrip/world'],
};

export default nextConfig;
