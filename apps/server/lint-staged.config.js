// Staged files under apps/server use this (the nearest) config.
// The room server lints with Prettier (see the "lint" script); format on commit.
module.exports = {
  '*.{js,ts}': ['prettier --write'],
  '*.{json,md,yaml,yml}': ['prettier --write'],
};
