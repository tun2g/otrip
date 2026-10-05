import type { SkyPalettes } from './recipe.ts';

/**
 * Sky colour follows climate and haze far more than it follows the town below,
 * so destinations share a small set of named skies rather than each carrying a
 * near-duplicate of the same nine colours.
 *
 * The night entries look far too bright read as hex. They are not: the renderer
 * writes them into an HDR buffer and ACES filmic tone mapping at exposure 1.05
 * runs over the whole frame afterwards, and its toe crushes anything under
 * about 0.02 linear to black. A night zenith authored at the brightness a night
 * sky "should" be came back at luminance 1 out of 255.
 *
 * The previous set claimed to be solved backwards through that curve and was
 * not: pushed through three's own ACES at this exposure, the coastal zenith as
 * authored lands at luminance 3.5 and the horizon at 21.3, and the frame they
 * actually produced measured a median of 21 against a reference night that sits
 * at 64. Worse, the coastal entries were *violet* — green below red, a linear
 * 1 : 0.70 : 1.64 — and no amount of moonlight makes a violet sky read as
 * moonlight. These are rebuilt to a blue-dominant ratio with green clearly
 * above red, around 1 : 1.9 : 4.2 at the horizon and 1 : 2.2 : 6.4 at the
 * zenith, and lifted to land in that 45-80 band. `sunCore` is the moon's own
 * colour, so it stays bright and goes cool rather than being lifted.
 */

/** Thin air, deep blue zenith, hard sunrise line. Mountains above the haze. */
export const HIGHLAND_SKIES: SkyPalettes = {
  night: {
    zenith: '#15233e',
    horizon: '#3a5176',
    sunCore: '#a3b4d1',
    sunGlow: '#6078a1',
    cloudLit: '#6c8ab8',
    cloudShadow: '#3b4f73',
    fog: '#455e86',
  },
  dawn: {
    zenith: '#2b3a66',
    horizon: '#f6b183',
    sunCore: '#fff3dc',
    sunGlow: '#f2a05c',
    cloudLit: '#f0f4f9',
    cloudShadow: '#b4c3d6',
    fog: '#efdcd0',
  },
  day: {
    zenith: '#2f68b5',
    horizon: '#bfd8ee',
    sunCore: '#fffdf4',
    sunGlow: '#ffe9bd',
    cloudLit: '#ffffff',
    cloudShadow: '#c3cfdd',
    fog: '#dfe8f1',
  },
};

/** Warm, humid, low contrast. Coastal central Vietnam. */
export const COASTAL_SKIES: SkyPalettes = {
  night: {
    zenith: '#1b2b4a',
    horizon: '#3c5379',
    sunCore: '#b2c5e4',
    sunGlow: '#566b90',
    cloudLit: '#4c6284',
    cloudShadow: '#2e3f5d',
    fog: '#384d6f',
  },
  dawn: {
    zenith: '#3a4a72',
    horizon: '#f3b58e',
    sunCore: '#fff0d8',
    sunGlow: '#ef9f63',
    cloudLit: '#f4efe8',
    cloudShadow: '#c6bcb2',
    fog: '#eeddcb',
  },
  day: {
    zenith: '#3b74bd',
    horizon: '#cfe0ef',
    sunCore: '#fffdf6',
    sunGlow: '#ffeec8',
    cloudLit: '#ffffff',
    cloudShadow: '#ccd5e0',
    fog: '#e4ecf3',
  },
};

/** Flat, often hazy, muted. The northern delta in winter. */
export const DELTA_SKIES: SkyPalettes = {
  night: {
    zenith: '#1b2b4b',
    horizon: '#445d87',
    sunCore: '#b3c6e6',
    sunGlow: '#6882ad',
    cloudLit: '#617da6',
    cloudShadow: '#36496b',
    fog: '#4a658e',
  },
  dawn: {
    zenith: '#39496b',
    horizon: '#e9b89a',
    sunCore: '#ffeedb',
    sunGlow: '#e4a278',
    cloudLit: '#eceef1',
    cloudShadow: '#bcc2cb',
    fog: '#e6dcd6',
  },
  day: {
    zenith: '#5b8ec4',
    horizon: '#d6e2ec',
    sunCore: '#fffcf5',
    sunGlow: '#ffeed2',
    cloudLit: '#fafcff',
    cloudShadow: '#cdd5de',
    fog: '#e6ecf1',
  },
};
