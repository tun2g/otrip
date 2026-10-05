// Staged files under apps/web use this (the nearest) config.
// Web lints with Prettier (see the "lint" script); format on commit.
module.exports = {
  '*.{js,jsx,ts,tsx}': ['prettier --write'],
  '*.{json,md,css,yaml,yml}': ['prettier --write'],
};
