import type { LocationRecipe } from './recipe.ts';
import { COASTAL_SKIES, DELTA_SKIES, HIGHLAND_SKIES } from './skies.ts';

/**
 * Tà Xùa, Bắc Yên, Sơn La — the ridge people climb at 5am to watch the sea of
 * clouds. Coordinates and elevation are the real ones (Bản Trò A, 1602m), so the
 * live weather layer reads the weather of the place the scene depicts.
 */
export const TA_XUA: LocationRecipe = {
  slug: 'ta-xua',
  name: 'Tà Xùa',
  region: 'Bắc Yên, Sơn La',
  description:
    'Sống núi Tà Xùa ở Bắc Yên, Sơn La, cao khoảng 1.600m — một trong những nơi người ta leo lên từ sớm để chờ biển mây. Trong otrip, địa hình được sinh bằng code từ một seed cố định, nên ngọn núi bạn thấy là đúng ngọn núi người bạn rủ đi cùng nhìn thấy.',
  seed: 'ta-xua-v1',
  coords: { lat: 21.2226, lon: 104.3881, elevation: 1602 },
  terrain: {
    profile: 'ridge',
    size: 5200,
    segments: 384,
    maxHeight: 900,
    ridgeFrequency: 0.00102,
    detailFrequency: 0.0019,
    ridgeWeight: 0.82,
    ridgeStretch: 0.55,
    smoothing: 2,
    edgeFalloff: 0.76,
    baseHeight: 0,
    river: null,
  },
  cloudSea: { altitude: 280, thickness: 140, layers: 5 },
  water: null,
  town: null,
  // Sơn La has no railway at all. The network's nearest rail is the
  // Hà Nội–Lào Cai line, over a hundred kilometres north-east, and nothing was
  // ever built into the Tây Bắc highlands — so there is no line to depict, and
  // the terrain could not carry one anyway: 900 m of relief across 5.2 km buys
  // a quarter-kilometre cutting at the 2.5% a locomotive can pull.
  railway: null,
  pois: [
    {
      id: 'dinh',
      name: 'Đỉnh Tà Xùa',
      kind: 'summit',
      note: 'Điểm cao nhất của sống núi. Khi độ ẩm lên gần bão hoà, mây dồn xuống thung lũng dưới chân và chỉ còn các đỉnh nhô lên.',
    },
    {
      id: 'song-lung',
      name: 'Sống lưng khủng long',
      kind: 'valley',
      note: 'Dải sống núi hẹp chạy giữa hai vực. Đứng đây là chỗ nhìn biển mây rõ nhất khi trời chịu cho mây.',
    },
    {
      id: 'ban',
      name: 'Bản trên núi',
      kind: 'town',
      note: 'Vài nếp nhà bám sườn dốc. Đây là nơi người ta thực sự dậy trước mặt trời.',
    },
    {
      id: 'rung',
      name: 'Rừng chè cổ',
      kind: 'grove',
      note: 'Vạt cây rậm dưới vành đai 300m, nơi sương đọng lâu nhất buổi sáng.',
    },
  ],
  scatter: { trees: 15000, houses: 90, treeLine: 860 },
  // The only one of the four where ruộng bậc thang belongs. Bắc Yên terraces the
  // slopes below the tea because there is no flat ground to farm instead.
  farming: 'terrace',
  // Mộc Châu and the Mường Tấc fields fly balloons; a 1602m sống núi does not,
  // because a balloon has to come down somewhere. The ridge's own sky sport is
  // the paraglider.
  aloft: 'paraglider',
  /**
   * Grass and tea on a ridge that is in sun above the cloud deck, which is a
   * luminous green rather than a deep one; the forest stays dark in `foliage`.
   *
   * The lift here is mostly in lightness, not hue, because lightness is what the
   * measurement said was missing. The sky fill adds a roughly fixed amount of
   * blue to every surface, so how much it desaturates one is decided by how
   * bright that surface already is: Hội An's mid is 1.6x brighter in linear luma
   * than this was and lands at 33.5% saturation with the air taken out, against
   * 17.4% here, off almost the same albedo chroma. Hue and HSL saturation are
   * held where they were and only the level moved.
   */
  ground: {
    low: '#538a2e',
    mid: '#73a338',
    high: '#859c51',
    rock: '#7c786b',
    foliage: '#2f6e38',
    roof: '#8a5a46',
  },
  skies: HIGHLAND_SKIES,
  /**
   * There are three rain beds across the four destinations rather than one,
   * because rain is the sound of whatever it lands on and these places give it
   * nothing in common. `rain-ridge` is open-country rain carried by wind, with no
   * surface near enough to patter on: measured on the shipped file it moves 6.5 LU
   * between the 5th and 95th percentile of short-term level, which is the gusting,
   * against 2.3 LU for Hội An's sheltered `rain-roof`. `rain-lake` is the other
   * extreme and carries no rumble at all — 15 dB more energy above 5 kHz than
   * below 150 Hz, where both of the others are around 10 dB the other way, which
   * is what rain hitting open water rather than ground sounds like.
   *
   * No water bed, because `water` is null — the ridge has nothing for one to be,
   * and the rain bed is what carries the weather here.
   */
  audio: {
    ambience: ['wind-ridge', 'rain-ridge', 'birds-dawn', 'forest-night'],
    music: ['dreamscape', 'rain'],
  },
};

/**
 * Hội An — the old town on the Thu Bồn. A delta profile with a channel carved
 * through it, so the river is terrain the water finds rather than a drawn shape.
 */
export const HOI_AN: LocationRecipe = {
  slug: 'hoi-an',
  name: 'Hội An',
  region: 'Đà Nẵng',
  description:
    'Phố cổ Hội An nằm bên sông Thu Bồn, gần như ngang mặt nước biển. Buổi tối phố lên đèn lồng và sông soi đèn — trong otrip, đèn tự bật khi mặt trời của chính Hội An lặn, chứ không phải theo giờ máy bạn.',
  seed: 'hoi-an-v1',
  coords: { lat: 15.87944, lon: 108.335, elevation: 13 },
  terrain: {
    profile: 'lowland',
    size: 3600,
    segments: 320,
    maxHeight: 120,
    ridgeFrequency: 0.0008,
    detailFrequency: 0.00275,
    ridgeWeight: 0.35,
    ridgeStretch: 0.9,
    smoothing: 2,
    edgeFalloff: 0.84,
    baseHeight: 36,
    river: { amplitude: 420, waves: 1.3, width: 330, depth: 58, alongX: true },
  },
  cloudSea: null,
  water: { level: 28, deep: '#2f4d55', shallow: '#5f8e87', ripple: 0.35 },
  town: {
    blocks: 26,
    perBlock: 30,
    minHeight: 6,
    maxHeight: 11,
    spread: 0.5,
    wall: '#dcc9a4',
    roof: '#9c4f3a',
    lanterns: true,
  },
  // "A few kilometres inland" was wrong, and a station was wronger. Hội An has no
  // railway of any kind: the nearest halt is Trà Kiệu (15.80944, 108.23111), and
  // the main line through it runs 11.7 km west of the old town — 6.5 times this
  // patch's half-extent of 1.8 km. Built anyway, the track crossed the whole map
  // and laid 589 sleeper decks within 37 m of the houses, three of them inside
  // 50 m. The way into Hội An has always been the road and the river, and the
  // scene has both.
  railway: null,
  pois: [
    {
      id: 'pho-co',
      name: 'Phố cổ',
      kind: 'town',
      note: 'Dãy nhà ống mái ngói bám hai bên sông. Tối đến cả phố lên đèn — kéo thanh giờ qua 19h để thấy.',
    },
    {
      id: 'ben-song',
      name: 'Bến sông Thu Bồn',
      kind: 'shore',
      note: 'Chỗ thuyền cập bờ. Lòng sông ở đây được khoét sâu nhất nên nước đậm màu hơn hẳn hai bên.',
    },
    {
      id: 'con-giua',
      name: 'Cồn giữa sông',
      kind: 'island',
      note: 'Dải đất nổi giữa dòng, chỉ đi tới được khi vòng qua mép nước.',
    },
    {
      id: 'dong',
      name: 'Đồng ngoài phố',
      kind: 'grove',
      note: 'Ra khỏi phố là ruộng và hàng cây. Đứng đây nhìn lại thấy rõ phố cổ nằm hoàn toàn dựa vào con sông.',
    },
  ],
  scatter: { trees: 7000, houses: 60, treeLine: 116 },
  // Đồng bằng ven biển: the fields outside the old town are flat wet rice on the
  // Thu Bồn's silt, which is why the POI out there is called "Đồng ngoài phố".
  // Nothing is stepped — there is no hill within sight of the town to step.
  farming: 'paddy',
  // Phố cổ Hội An is one of the handful of places that holds a balloon festival.
  aloft: 'balloon',
  /**
   * Left where it is: measured on a clear 32 km afternoon this is the only one of
   * the four that already reads as vegetation, at 33.5% saturation with the air
   * taken out against 9-17% for the others, and the other three were moved toward
   * it rather than the reverse. `mid` has red level with green, which on its own
   * is khaki — but its blue is far lower than the rest, and that is what makes it
   * a dry-season stubble ochre instead. The delta in October is cut paddy.
   */
  ground: {
    low: '#718e3a',
    mid: '#9f9f47',
    high: '#b59c5d',
    rock: '#9d937f',
    foliage: '#346b2b',
    roof: '#9c4f3a',
  },
  skies: COASTAL_SKIES,
  audio: {
    ambience: ['wind-trees', 'rain-roof', 'water-lap', 'birds-village', 'forest-night'],
    music: ['dreamscape', 'rain'],
  },
};

/**
 * Tràng An, Ninh Bình — limestone towers standing in still water. The karst
 * profile keeps the ground flat and lets only the high tail of the noise rise,
 * which is what makes towers instead of hills. Weather is Ninh Bình's.
 *
 * The numbers here are a floodplain, not a lake: under the karst profile
 * `baseHeight` is the plain in metres, and the waterline sits three quarters of
 * the way into its swell, so the low lobes flood ankle- to chest-deep while the
 * rest stays dry ground a village and a path can stand on. There is no carved
 * channel on purpose — the waterway at Tràng An is the flooded low ground
 * threading between the towers, and a sine-wave river cut across this plain
 * reads as a dry ditch wherever the swell is high and halves the dry land.
 */
export const TRANG_AN: LocationRecipe = {
  slug: 'trang-an',
  name: 'Tràng An',
  region: 'Hoa Lư, Ninh Bình',
  description:
    'Quần thể Tràng An ở Ninh Bình: núi đá vôi dựng thẳng giữa mặt nước lặng, thuyền nan luồn qua chân núi. Thời tiết trong cảnh lấy theo Ninh Bình, nơi cách khu danh thắng chừng vài cây số.',
  seed: 'trang-an-v1',
  coords: { lat: 20.25809, lon: 105.97965, elevation: 7 },
  terrain: {
    profile: 'karst',
    size: 3800,
    segments: 320,
    maxHeight: 200,
    ridgeFrequency: 0.00088,
    detailFrequency: 0.0023,
    ridgeWeight: 0.95,
    ridgeStretch: 0.85,
    smoothing: 2,
    edgeFalloff: 0.88,
    baseHeight: 18,
    river: null,
  },
  cloudSea: null,
  water: { level: 13.5, deep: '#1f5b58', shallow: '#56a99b', ripple: 0.16 },
  town: null,
  // Ninh Bình is on the main line, but the line runs east of here through the
  // city, not across the scenic complex — and this patch is the complex. Nor
  // could it: a third of the patch is standing water and the dry third is
  // threaded with limestone towers, so a line across it would be kilometres of
  // causeway and tunnel through karst that nobody has ever had a reason to build.
  railway: null,
  pois: [
    {
      id: 'thap-cao',
      name: 'Tháp đá cao nhất',
      kind: 'summit',
      note: 'Khối đá vôi dựng thẳng từ mặt nước. Chân núi bị nước ăn vào nên nhìn như mọc lên từ hồ.',
    },
    {
      id: 'ben-thuyen',
      name: 'Bến thuyền nan',
      kind: 'shore',
      note: 'Mép nước nông, chỗ thuyền xuất phát. Bạn sẽ thấy vệt sáng của bờ chạy dọc chân các tháp đá.',
    },
    {
      id: 'dao-nho',
      name: 'Đảo nhỏ giữa hồ',
      kind: 'island',
      note: 'Mỏm đất lọt thỏm giữa mặt nước, bốn bề là đá.',
    },
  ],
  scatter: { trees: 8000, houses: 26, treeLine: 150 },
  // Flat paddy on the floor between the towers — the rice at Tam Cốc and Tràng An
  // is the image the place is known for in May. Never on the towers themselves:
  // their flanks are bare limestone cliff and nobody has ever cut a bed into one.
  farming: 'paddy',
  // Lễ hội khinh khí cầu Tràng An – Cúc Phương launches from the culture park at
  // the mouth of this complex: 35 balloons over exactly this landscape.
  aloft: 'balloon',
  /** Scrub and wet paddy between the towers; the limestone itself stays in `rock`. */
  ground: {
    low: '#5f9442',
    mid: '#7aa052',
    high: '#9ba075',
    rock: '#8d9386',
    foliage: '#2d7038',
    roof: '#8a6a4e',
  },
  skies: DELTA_SKIES,
  /**
   * `wind-trees` and not `wind-ridge` although these are mountains: the towers
   * stand in a sheltered floodplain and the microphone is down among the scrub at
   * the waterline, not on an exposed crest. Without any wind bed at all the live
   * `windSpeed` had nothing to act on here, which is the one weather number this
   * place could still hear.
   */
  audio: {
    ambience: ['wind-trees', 'rain-lake', 'stream', 'birds-village', 'forest-night'],
    music: ['dreamscape', 'rain'],
  },
};

/**
 * Hồ Tây — the lake is most of the map, with the city standing back from it.
 * Weather is Hà Nội's, which is the lake's weather.
 */
export const HO_TAY: LocationRecipe = {
  slug: 'ho-tay',
  name: 'Hồ Tây',
  region: 'Tây Hồ, Hà Nội',
  description:
    'Hồ Tây là hồ lớn nhất Hà Nội, sáng mùa đông hay có sương phủ mặt nước và thành phố lùi lại phía sau. Trong otrip, sương dày mỏng theo độ ẩm và tầm nhìn thật của Hà Nội lúc bạn mở trang.',
  seed: 'ho-tay-v1',
  coords: { lat: 21.0245, lon: 105.84117, elevation: 10 },
  terrain: {
    profile: 'lowland',
    size: 4200,
    segments: 320,
    maxHeight: 130,
    ridgeFrequency: 0.00057,
    detailFrequency: 0.0019,
    ridgeWeight: 0.3,
    ridgeStretch: 1,
    smoothing: 3,
    edgeFalloff: 0.92,
    baseHeight: 42,
    river: { amplitude: 0, waves: 1, width: 990, depth: 50, alongX: false },
  },
  cloudSea: null,
  water: { level: 28, deep: '#2b3f52', shallow: '#6d8a9c', ripple: 0.3 },
  town: {
    blocks: 58,
    perBlock: 34,
    minHeight: 16,
    maxHeight: 72,
    spread: 0.95,
    wall: '#b9bec6',
    roof: '#8b9099',
    lanterns: true,
  },
  // Hanoi is the hub of the network, and this is the one of the four with a line
  // genuinely near it — but not where this once said. The Hà Nội–Lào Cai trains
  // leave Hà Nội station, run north through Hoàn Kiếm and cross the Red River on
  // cầu Long Biên; they do not pass between the lake and the river. The track is
  // about 2.7 km south-east of the lake centre against a patch half-extent of
  // 2.1 km, so it grazes this map rather than crossing it. Kept because a metre
  // gauge line really is that close and the measured alignment puts it on the
  // river side, where it is drawn; no platform, because the nearest stops are
  // Long Biên and Gia Lâm.
  railway: { carriages: 5, headway: 260, station: false },
  pois: [
    {
      id: 'bo-ho',
      name: 'Bờ hồ',
      kind: 'shore',
      note: 'Mép nước nơi thành phố dừng lại. Sáng mùa đông sương phủ kín, bờ bên kia biến mất hoàn toàn.',
    },
    {
      id: 'pho',
      name: 'Khu phố cao tầng',
      kind: 'town',
      note: 'Dãy nhà quay mặt ra hồ. Đèn cửa sổ tự bật khi mặt trời Hà Nội lặn.',
    },
    {
      id: 'ban-dao',
      name: 'Bán đảo',
      kind: 'island',
      note: 'Dải đất ăn ra giữa hồ, ba mặt là nước.',
    },
    {
      id: 'vuon',
      name: 'Vườn ven hồ',
      kind: 'grove',
      note: 'Khoảng cây xanh còn sót lại giữa hai khu nhà.',
    },
  ],
  scatter: { trees: 6500, houses: 40, treeLine: 120 },
  // Tây Hồ is an inner district: the open ground by the lake is park, and what is
  // still grown here is the Nhật Tân peach and Tứ Liên kumquat gardens, not a
  // crop field. So no fields at all — the slopes carry park grass and trees from
  // `ground-cover` and `nature-scatter`, which is what the ground palette above
  // is already painted for.
  farming: 'none',
  // Hanoi does fly balloons, from vườn nhãn Long Biên under cầu Vĩnh Tuy — the
  // other side of the city. Nothing launches over Tây Hồ, and what is actually
  // overhead here is the Nội Bài traffic, which the airliner already carries.
  aloft: 'none',
  /** Park grass and plane trees on a city shore — a duller, yellower green than
   * the highland, but still a green rather than the olive-grey it was. */
  ground: {
    low: '#76934c',
    mid: '#95ac5e',
    high: '#a3a37d',
    rock: '#908c83',
    foliage: '#3b7836',
    roof: '#7d6a5c',
  },
  skies: DELTA_SKIES,
  audio: {
    ambience: ['wind-trees', 'rain-lake', 'water-lap', 'birds-village', 'forest-night'],
    music: ['dreamscape', 'rain'],
  },
};

export const LOCATIONS: Record<string, LocationRecipe> = {
  [TA_XUA.slug]: TA_XUA,
  [HOI_AN.slug]: HOI_AN,
  [TRANG_AN.slug]: TRANG_AN,
  [HO_TAY.slug]: HO_TAY,
};

export const LOCATION_SLUGS = Object.keys(LOCATIONS);

export const getLocation = (slug: string): LocationRecipe | undefined => LOCATIONS[slug];
