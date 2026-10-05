import type { LocationRecipe } from '@otrip/world';

/**
 * What a place is actually worth waiting for.
 *
 * The app used to invite everyone to hunt a sea of cloud. Three of the four
 * destinations have `cloudSea: null` and draw no cloud sea at any hour, so at
 * Hội An, Tràng An and Hồ Tây that was an invitation to wait for something the
 * renderer never produces. The score behind it is the same three numbers —
 * humidity, low cloud and wind — and those read just as honestly as mist on a
 * river or fog on a lake; it is only the name of the prize that was wrong.
 *
 * Read off the recipe rather than keyed by slug, so a fifth destination
 * describes itself the moment its recipe exists.
 */
export type Draw = {
  /** The thing itself: "biển mây", "sương mù trên hồ". */
  noun: string;
  /** The hourly score's own heading, without the leading "Cơ hội". */
  chance: string;
  /** How the low-cloud reading reads when it is in the useful band. */
  lowCloudPromise: string;
  /**
   * The alarm clause, read after the place name: "Hồ Tây: sương mù sắp phủ mặt
   * hồ". `noun` alone will not do this job — it names the thing, and dropping a
   * place name into it gives "sương mù trên hồ Hồ Tây" and "bình minh trên sông
   * Hội An", which rename the lake and the river after the town.
   */
  rising: string;
};

const CLOUD_SEA: Draw = {
  noun: 'biển mây',
  chance: 'săn mây',
  lowCloudPromise: 'đủ dày để thành biển mây',
  rising: 'biển mây sắp lên',
};

const RIVER_DAWN: Draw = {
  noun: 'bình minh trên sông',
  chance: 'sương sớm trên sông',
  lowCloudPromise: 'đủ ẩm để đọng sương trên mặt sông',
  rising: 'sương sớm sắp đọng trên sông',
};

const KARST_MIST: Draw = {
  noun: 'sương trên mặt nước',
  chance: 'sương trên mặt nước',
  lowCloudPromise: 'đủ dày để sương đọng giữa các núi đá',
  rising: 'sương sắp đọng giữa núi đá',
};

const LAKE_FOG: Draw = {
  noun: 'sương mù trên hồ',
  chance: 'sương mù trên hồ',
  lowCloudPromise: 'đủ ẩm để sương phủ mặt hồ',
  rising: 'sương mù sắp phủ mặt hồ',
};

export const drawOf = (recipe: LocationRecipe): Draw => {
  if (recipe.cloudSea) return CLOUD_SEA;
  if (recipe.terrain.river && recipe.terrain.river.amplitude > 0) return RIVER_DAWN;
  if (recipe.water) return recipe.terrain.profile === 'karst' ? KARST_MIST : LAKE_FOG;
  return CLOUD_SEA;
};
