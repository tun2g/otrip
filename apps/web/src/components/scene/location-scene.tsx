'use client';

import { deriveSkyState, type SkyState } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SceneCanvas } from '@/components/scene/scene-canvas';
import { ActionPrompt } from '@/components/ui/action-prompt';
import { AudioControls } from '@/components/ui/audio-controls';
import { NightNotice } from '@/components/ui/night-notice';
import { CompanionCompass } from '@/components/ui/companion-compass';
import { RideDash } from '@/components/ui/ride-dash';
import { ControlHints, LocationCard } from '@/components/ui/scene-hud';
import { PanelTabs, type PanelTab } from '@/components/ui/panel-tabs';
import { PauseMenu } from '@/components/ui/pause-menu';
import { SkyControls } from '@/components/ui/sky-controls';
import { WeatherPicker } from '@/components/ui/weather-picker';
import { TouchJoystick } from '@/components/ui/touch-joystick';
import { ExplorePanel, type Heading } from '@/components/ui/explore-panel';
import { Minimap } from '@/components/ui/minimap';
import { SettingsPanel } from '@/components/ui/settings-panel';
import { WorldMap, useRelief, type MapRoute } from '@/components/ui/world-map';
import type { MapRide } from '@/components/ui/map-symbols';
import { TripPanel } from '@/components/ui/trip-panel';
import { inviteUrl as buildInviteUrl, readRoomId } from '@/lib/trip-client';
import { useAudio } from '@/hooks/use-audio';
import { useForecast } from '@/hooks/use-forecast';
import { useExploration } from '@/hooks/use-exploration';
import { useSettings } from '@/hooks/use-settings';
import { useTrip } from '@/hooks/use-trip';
import { ambienceMix } from '@/lib/ambience';
import { cn } from '@/lib/utils';
import { composePostcard, downloadPostcard } from '@/lib/postcard';
import { buildReminder, downloadReminder } from '@/lib/reminder';
import {
  DEFAULT_WEATHER_PRESET,
  applyWeatherPreset,
  presetSkyConditions,
  effectivePreset,
  isPresetId,
  type WeatherPresetId,
} from '@/lib/weather-presets';
import { formatHour, goldenHourIndex, hourToDate, todayAt, weatherLabel } from '@/lib/forecast';
import type { Joystick } from '@/scene/walker';
import type { ResolvedPoi } from '@/scene/points-of-interest';
import type { WorldWeather } from '@/scene/weather-state';
import type { LocalMove, WorldRenderer } from '@/scene/world-renderer';

/**
 * Wall-clock seconds spent on each forecast hour while the clock runs. The
 * renderer eases every sky change over about a second, so these are slow enough
 * for the blend to read as light moving rather than as a slideshow.
 */
const SPEEDS = [60, 40, 20];

/** Hours of darkness to start from, so a sunrise is approached and not cut to. */
const SUNRISE_LEAD = 2;

/** Pointer lock is lost by task switching as well as by ESC; wait long enough
 *  for focus and visibility to settle before deciding which one happened. */
const UNLOCK_GRACE = 250;

export const LocationScene = ({ recipe }: { recipe: LocationRecipe }) => {
  const { forecast, error, nowIndex } = useForecast(recipe.slug);
  const trip = useTrip(recipe.slug);
  const [pendingTrip, setPendingTrip] = useState<{ name: string; roomId?: string } | null>(null);
  const inviteHandled = useRef(false);
  const settings = useSettings();
  const exploration = useExploration(recipe.slug);

  const [picked, setPicked] = useState<number | null>(null);
  const [shareLabel, setShareLabel] = useState('Chép link');
  const [inviteLabel, setInviteLabel] = useState('Chép lời mời');
  const [walking, setWalking] = useState(false);
  // On foot the screen belongs to the world. The panels come back on ESC, the
  // way a game hands you its menu, and go away again the moment you resume.
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelsHidden, setPanelsHidden] = useState(false);
  // Closed on arrival. A phone opens straight onto the landscape with nothing
  // but the tab row over it — the complaint that started this was that the
  // panels covered the thing you came to look at, and that was only ever fixed
  // for walking. From `sm` up the tabs do not exist and all three panels show
  // regardless, so this costs a desktop nothing.
  const [tab, setTab] = useState<PanelTab | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [joystick, setJoystick] = useState<Joystick | null>(null);
  const [locked, setLocked] = useState(false);
  const [view, setView] = useState<'first' | 'third'>('third');
  const [hintVisible, setHintVisible] = useState(true);
  const [photoLabel, setPhotoLabel] = useState('Chụp ảnh');
  const [remindLabel, setRemindLabel] = useState('Nhắc tôi');
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localPreset, setLocalPreset] = useState<WeatherPresetId>(DEFAULT_WEATHER_PRESET);
  const [localSpeedStep, setLocalSpeedStep] = useState(1);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const [pois, setPois] = useState<ResolvedPoi[]>([]);
  /**
   * Where the rides actually are, polled live.
   *
   * It was `renderer.parking` — the kerb-side slots `road-network` publishes,
   * resolved once at build. Those are where a bike *stands*, not where one is,
   * and the two part company the moment anybody rides one away: the slot keeps
   * its pin and the machine is kilometres off. It was also the wrong count by
   * 3.3×, because the maps drew one pin per slot and a row is four slots — a
   * player's screenshot of Hồ Tây showed pins numbered to "Điểm lấy xe máy 20"
   * for six bikes, fourteen of them empty kerb.
   */
  const [rides, setRides] = useState<readonly MapRide[]>([]);
  const [routes, setRoutes] = useState<MapRoute[]>([]);
  const [player, setPlayer] = useState<{ x: number; z: number; yaw: number } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [nightDismissed, setNightDismissed] = useState(true);

  // Shared with the full map, so opening it costs nothing.
  const relief = useRelief(recipe);

  /**
   * The comfort preferences as one value with a stable identity.
   *
   * `setComfort` rebuilds the projection matrix when the field of view changes,
   * and the effect that calls it depends on this object — so a fresh literal on
   * every render would rebuild it on every render. The three fields are what the
   * memo watches, so it changes exactly when one of them does.
   */
  const comfort = useMemo(
    () => ({ cameraMotion: settings.cameraMotion, vignette: settings.vignette, fov: settings.fov }),
    [settings.cameraMotion, settings.vignette, settings.fov]
  );

  const goldenIndex = useMemo(() => (forecast ? goldenHourIndex(forecast, nowIndex) : null), [forecast, nowIndex]);

  // The forecast hour the next real sunrise falls in. `goldenHourIndex` is a
  // different question — the best-scoring hour in the three hours after a
  // sunrise — and labelling that one "bình minh" handed people 08:00.
  const sunriseIndex = useMemo<number | null>(() => {
    const from = forecast?.hours[nowIndex];
    if (!forecast || !from) return null;
    const fromAt = Date.parse(`${from.time}:00Z`);

    for (const sunrise of forecast.sunrises) {
      if (Date.parse(`${sunrise}:00Z`) < fromAt) continue;
      const stamp = sunrise.slice(0, 13);
      const found = forecast.hours.findIndex((hour, at) => at >= nowIndex && hour.time.slice(0, 13) === stamp);
      if (found >= 0) return found;
    }

    return null;
  }, [forecast, nowIndex]);

  /**
   * Who decides what hour it is, what the weather is doing and whether the clock
   * is running: the room, when there is one.
   *
   * Two friends standing in the same place were standing in it at different
   * times of day, under different weather, with one of them watching the light
   * move and the other not. The room now carries all three, and it is the
   * authority while you are in one — last writer wins, with no host, because the
   * social unit here is a few people who already know each other.
   */
  const inRoom = trip.status === 'joined';

  /**
   * One tick a second while the room's clock runs, and nothing otherwise.
   *
   * The shared hour is *derived* from an anchor rather than stepped on a local
   * interval — that is what makes two clients agree instead of merely both run,
   * since each browser's own interval starts whenever its page happened to load
   * and the two can sit a whole forecast hour apart. Deriving it means something
   * has to re-read it, which is all this is.
   */
  const [roomTick, setRoomTick] = useState(0);
  useEffect(() => {
    if (!inRoom || !trip.world.playing) return;
    const timer = window.setInterval(() => setRoomTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [inRoom, trip.world.playing]);

  const playing = inRoom ? trip.world.playing : localPlaying;
  const speedStep = inRoom ? (SPEEDS[trip.world.speedStep] === undefined ? 1 : trip.world.speedStep) : localSpeedStep;
  const secondsPerHour = SPEEDS[speedStep] ?? 40;

  /**
   * The hour the room is in, or null when nobody has pinned one and it is
   * following the destination's own.
   *
   * Carried as the forecast's stamp and not as an index, for the reason the
   * `?luc=` handling below already records: the 48-hour window is anchored at
   * the destination's midnight, so an index pinned one evening points at a
   * different hour by morning.
   */
  const roomIndex = useMemo<number | null>(() => {
    if (!inRoom || !forecast || !trip.world.hourStamp) return null;
    const base = forecast.hours.findIndex((hour) => hour.time === trip.world.hourStamp);
    if (base < 0) return null;
    if (!trip.world.playing) return base;
    const stepped = Math.floor((trip.serverNow() - trip.world.anchorAt) / 1000 / secondsPerHour);
    return Math.min(forecast.hours.length - 1, base + Math.max(0, stepped));
    // `roomTick` is the dependency that makes a running clock advance; it is read
    // nowhere in the body and that is deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom, forecast, trip.world, trip.serverNow, secondsPerHour, roomTick]);

  /**
   * The hour on screen: the room's if there is one, then this machine's own pin,
   * then whatever hour the place is really living in.
   */
  /**
   * The weather everyone in the room is being shown. The picker is "a lie by
   * design" and two people should at least be told the same lie.
   *
   * An unknown id from the room falls back to this machine's own choice rather
   * than to the default: the preset table is a browser file the server has never
   * seen, so a client on a newer build can legitimately name one this one does
   * not have, and blanking the sky for that is worse than disagreeing about it.
   */
  const preset: WeatherPresetId = inRoom && isPresetId(trip.world.preset) ? trip.world.preset : localPreset;

  const index = roomIndex ?? picked ?? nowIndex;

  // Everything that runs off a timer reads these from here, so that neither
  // advancing an hour nor the hourly refetch nor the real hour turning over can
  // tear down an interval and reset the wait someone is sitting through.
  const liveRef = useRef({ forecast, nowIndex, index });
  useEffect(() => {
    liveRef.current = { forecast, nowIndex, index };
  }, [forecast, nowIndex, index]);

  /**
   * The room, for the callbacks that must not be rebuilt when it changes.
   *
   * `select` is memoised with no dependencies — deliberately, because the
   * timers below hold it and rebuilding it would tear an interval down and
   * reset the wait somebody is sitting through. A ref is how it reaches the room
   * without taking that back.
   */
  const roomRef = useRef({ inRoom: false, setHour: trip.setHour, setClock: trip.setClock });
  useEffect(() => {
    roomRef.current = { inRoom, setHour: trip.setHour, setClock: trip.setClock };
  }, [inRoom, trip.setHour, trip.setClock]);

  const select = useCallback((next: number) => {
    const { forecast, nowIndex } = liveRef.current;
    const hour = forecast?.hours[next];
    if (!hour) return;

    // Choosing the hour the place is already living in means "follow the clock",
    // not "pin me to 11:00": `picked` goes back to null so the scene moves on as
    // the hour turns, and the link stops carrying an hour that was only ever
    // meant as "bây giờ" — reopened an hour later, such a link used to insist on
    // a past hour while the badge beside it still read "đang diễn ra".
    const following = next === nowIndex;
    setPicked(following ? null : next);
    // In a room the hour belongs to the room, so it goes there as the forecast's
    // own stamp. `null` hands it back to the destination's real hour, which is
    // what choosing "bây giờ" means.
    if (roomRef.current.inRoom) roomRef.current.setHour(following ? null : hour.time);

    const url = new URL(window.location.href);
    if (following) url.searchParams.delete('luc');
    else url.searchParams.set('luc', hour.time);
    window.history.replaceState(null, '', url);
  }, []);

  // The scrubbed hour lives in the URL so a moment worth showing someone is a
  // link, not a description. Read after mount to keep the server render stable.
  //
  // Re-read on every refetch, not only on arrival: the window is anchored at the
  // destination's midnight, so a forecast fetched after midnight holds the same
  // hour at a lower index. Pinning by stamp survives that; pinning by index drew
  // whatever hour slid into the slot. An hour that has left the window hands the
  // clock back to now rather than keeping a pin on nothing.
  useEffect(() => {
    if (!forecast) return;
    const wanted = new URLSearchParams(window.location.search).get('luc');
    if (!wanted) return;
    const found = forecast.hours.findIndex((hour) => hour.time === wanted);
    if (found >= 0) setPicked(found);
    else select(nowIndex);
  }, [forecast, nowIndex, select]);

  /**
   * A room id in the URL lands here and is joined without making anybody hunt
   * for a button.
   *
   * It is now the page's *own* URL and not only a link somebody was sent:
   * `useTrip` writes `?r=` into the address bar the moment there is a room, so a
   * reload rejoins and a second window opened on the same URL joins rather than
   * creating. That last part was a trap worth closing — a join with no room id
   * calls `client.create`, so two windows that each pressed "Rủ bạn đi cùng"
   * ended up in two different rooms, both correctly reading "Chỉ có bạn", and
   * the only path that ever shared a room was the copied invite link.
   */
  useEffect(() => {
    const invited = readRoomId();
    if (!invited || inviteHandled.current) return;
    inviteHandled.current = true;
    let remembered = 'Khách';
    try {
      remembered = window.localStorage.getItem('otrip:name') ?? remembered;
    } catch {}
    setPendingTrip({ name: remembered, roomId: invited });
  }, [trip]);

  // Wait for the actual walker: the server must validate movement from the
  // same starting point, including when an invite arrives before assets load.
  useEffect(() => {
    if (!pendingTrip) return;
    const join = () => {
      const renderer = rendererRef.current;
      if (!renderer) return false;
      renderer.setWalking(true);
      setWalking(true);
      trip.start(pendingTrip.name, pendingTrip.roomId, renderer.localPosition());
      setPendingTrip(null);
      return true;
    };
    if (join()) return;
    const timer = window.setInterval(() => {
      if (join()) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [pendingTrip, trip.start]);

  useEffect(() => {
    if (trip.status === 'joined') setWalking(true);
  }, [trip.status]);

  useEffect(() => {
    if (!walking) return;
    setHintVisible(true);
    const timer = window.setTimeout(() => setHintVisible(false), 7000);
    return () => window.clearTimeout(timer);
  }, [walking]);

  // No forecast means no sky update at all: the renderer keeps the sunrise it
  // opens with, which is a better failure than a grey screen.
  const sky = useMemo<SkyState | undefined>(() => {
    const hour = forecast?.hours[index];
    if (!forecast || !hour) return undefined;

    // The preset's atmosphere goes through here as well as through the weather:
    // `deriveSkyState` reads these three for the fog and the cloud deck, so
    // leaving them real is what made "Sương mù" a 420 m scene seen through 14 km
    // of clean air. The time of day is untouched — it comes from `at` and
    // `coords`, which no preset is allowed near.
    return deriveSkyState(
      hourToDate(hour.time, forecast.utcOffsetSeconds),
      recipe.coords,
      presetSkyConditions(preset, recipe, {
        lowCloudCover: hour.lowCloudCover,
        humidity: hour.humidity,
        visibility: hour.visibility,
      })
    );
  }, [forecast, index, recipe, preset]);

  /**
   * What the forecast actually says for the chosen hour, kept visible while a
   * preset is on. The picker is a lie by design; this is the line that stops it
   * being a lie anyone can act on.
   */
  const realLabel = useMemo(() => {
    const hour = forecast?.hours[index];
    if (!hour) return undefined;
    return `${weatherLabel(hour.weatherCode)} · ${Math.round(hour.temperature)}°C`;
  }, [forecast, index]);

  /** 0 by day .. 1 at full dark. The sun's real position, never a preset's. */
  const night = useMemo(() => (sky ? Math.min(1, Math.max(0, -sky.sunElevation / 8)) : 0), [sky]);

  // One weather, derived once. Everything in the scene — cloud, rain, wind,
  // whether the moon is visible at all — reads this and nothing else.
  const weather = useMemo<WorldWeather | undefined>(() => {
    const hour = forecast?.hours[index];
    if (!sky || !hour) return undefined;

    return applyWeatherPreset(preset, recipe, hour, night, sky.daylight);
  }, [sky, night, forecast, index, preset, recipe]);

  const layers = useMemo(() => {
    const hour = forecast?.hours[index];
    // Before any data lands, keep a quiet ridge wind rather than silence.
    if (!sky || !hour) return [{ name: recipe.audio.ambience[0] ?? 'wind-ridge', gain: 0.35 }];
    // The hour the sky was painted from, not the one the forecast holds: with a
    // preset on they are different hours, and the ear was still being told the
    // real one. Asking for a storm left the birds singing.
    return ambienceMix(sky, effectivePreset(preset, recipe).override ?? hour);
  }, [sky, forecast, index, preset, recipe]);

  const audio = useAudio(recipe.audio.ambience, recipe.audio.music, layers);

  useEffect(() => {
    // In a room the hour is derived from the room's anchor, so stepping it here
    // as well would advance it twice — and the two would disagree, because this
    // interval starts whenever this page loaded.
    if (!playing || inRoom) return;

    const timer = window.setInterval(() => {
      const { forecast, index } = liveRef.current;
      if (!forecast) return;
      const next = index + 1;
      // The forecast is 48 hours long; wrapping would throw the sky two days
      // backwards, so the clock simply arrives at the end and stops.
      if (next > forecast.hours.length - 1) {
        setPlaying(false);
        return;
      }
      select(next);
    }, secondsPerHour * 1000);

    return () => window.clearInterval(timer);
  }, [playing, inRoom, secondsPerHour, select]);

  /** The stamp of whatever hour is on screen. `setClock` has to carry it: pausing
   *  without restating it snaps everybody back to the hour play started from. */
  const showingStamp = useCallback(() => liveRef.current.forecast?.hours[liveRef.current.index]?.time ?? null, []);

  const setPlaying = useCallback(
    (value: boolean) => {
      if (inRoom) {
        trip.setClock(value, speedStep, showingStamp());
        return;
      }
      setLocalPlaying(value);
    },
    [inRoom, trip.setClock, speedStep, showingStamp]
  );

  const cycleSpeed = useCallback(() => {
    const next = (speedStep + 1) % SPEEDS.length;
    if (inRoom) {
      trip.setClock(playing, next, showingStamp());
      return;
    }
    setLocalSpeedStep(next);
  }, [inRoom, trip.setClock, speedStep, playing, showingStamp]);

  const choosePreset = useCallback(
    (next: WeatherPresetId) => {
      // Local as well as remote: the room echoes back in a few tens of
      // milliseconds, and the picker should not sit on the old answer until it
      // does. `inRoom` then prefers the room's, so they converge rather than fight.
      setLocalPreset(next);
      if (inRoom) trip.setPreset(next);
    },
    [inRoom, trip.setPreset]
  );

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (forecast && index >= forecast.hours.length - 1) select(nowIndex);
    setPlaying(true);
  }, [playing, forecast, index, nowIndex, select]);

  const playSunrise = useCallback(() => {
    if (sunriseIndex === null) return;
    select(Math.max(nowIndex, sunriseIndex - SUNRISE_LEAD));
    setPlaying(true);
  }, [nowIndex, select, sunriseIndex]);

  const copy = useCallback(async (url: string, title: string, setLabel: (value: string) => void, idle: string) => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // Sharing was dismissed; fall through to the clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setLabel('Đã chép');
    } catch {
      setLabel('Không chép được');
    }
    window.setTimeout(() => setLabel(idle), 2000);
  }, []);

  const share = useCallback(
    () => copy(window.location.href, `${recipe.name} lúc này trên otrip`, setShareLabel, 'Chép link'),
    [copy, recipe.name]
  );

  // Built from the page's own URL, so whatever hour is pinned in `?luc=` travels
  // with the invitation. The key and what counts as an id live with the
  // transport, which is the file that puts the id into `joinById`.
  const inviteUrl = useMemo(
    () => (typeof window === 'undefined' || !trip.roomId ? null : buildInviteUrl(trip.roomId)),
    [trip.roomId]
  );

  const copyInvite = useCallback(() => {
    if (!inviteUrl) return;
    void copy(inviteUrl, `Đi ${recipe.name} cùng mình trên otrip`, setInviteLabel, 'Chép lời mời');
  }, [copy, inviteUrl, recipe.name]);

  // Remembering the name is what lets an invite link join straight away instead
  // of stopping a guest at a form they already filled in once.
  const beginTrip = useCallback(
    (name: string) => {
      try {
        window.localStorage.setItem('otrip:name', name);
      } catch {
        // Private browsing: the trip still works, the name just is not kept.
      }
      const roomId = readRoomId() ?? undefined;
      setPendingTrip({ name, roomId });
    },
    [trip]
  );

  // The renderer appears a moment after mount, so the places it resolved
  // against the terrain are picked up on a short poll rather than guessed at
  // render time.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer || cancelled) return;
      setPois(renderer.pois);
      // Both are resolved once at build, so the same tick that finds the places
      // finds the roads between them. Reading `routes` off the ref at render
      // time instead only ever worked because setting `pois` happened to force
      // the render that re-read it — the map drew roads by coincidence.
      setRoutes(renderer.routes);
      window.clearInterval(timer);
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [recipe.slug]);

  // Walking is a clean screen; ESC is how you get the menu. Leaving the walk
  // resets both flags so the browsing view is never stuck empty.
  const wasLockedRef = useRef(false);
  const unlockTimerRef = useRef(0);

  useEffect(() => {
    setMenuOpen(false);
    if (walking) {
      setPanelsHidden(false);
      return;
    }
    wasLockedRef.current = false;
  }, [walking]);

  useEffect(() => () => window.clearTimeout(unlockTimerRef.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (event.key === 'Escape' && walking) {
        event.preventDefault();
        setMenuOpen((value) => !value);
        return;
      }

      // The "Thu gọn" button has always advertised H; now it exists.
      if ((event.key === 'h' || event.key === 'H') && !typing) {
        event.preventDefault();
        if (walking) setMenuOpen(false);
        else setPanelsHidden((value) => !value);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [walking]);

  // While the pointer is captured the browser eats the ESC that releases it, so
  // the key handler above never fires and losing the lock *is* that press — but
  // alt-tabbing drops the lock too, and treating that as a deliberate exit put
  // the whole menu over the world every time you came back. A real ESC leaves
  // the page focused and visible; a task switch does not.
  const onLockChange = useCallback(
    (value: boolean) => {
      setLocked(value);
      window.clearTimeout(unlockTimerRef.current);
      if (value) {
        wasLockedRef.current = true;
        return;
      }
      // Only a lock we actually held can have been given up. The walker reports
      // its current state the moment a handler is registered, which happens
      // again every time this callback's identity changes — that echo used to
      // throw the menu open the instant you pressed "Đi bộ".
      if (!walking || !wasLockedRef.current) return;
      wasLockedRef.current = false;

      unlockTimerRef.current = window.setTimeout(() => {
        if (document.hasFocus() && document.visibilityState === 'visible') setMenuOpen(true);
      }, UNLOCK_GRACE);
    },
    [walking]
  );

  const resume = useCallback(() => {
    setMenuOpen(false);
    // Only a mouse had the lock in the first place; asking a phone for it does
    // nothing but risk a rejected request.
    if (wasLockedRef.current) rendererRef.current?.requestLock();
  }, []);

  useEffect(() => {
    rendererRef.current?.setDiscovered(exploration.discovered);
  }, [exploration.discovered, pois]);

  useEffect(() => {
    rendererRef.current?.onDiscover(exploration.discover);
    return () => rendererRef.current?.onDiscover(null);
  }, [exploration.discover, pois]);

  useEffect(() => {
    rendererRef.current?.onViewChange(setView);
    return () => rendererRef.current?.onViewChange(null);
  }, [walking, pois]);

  useEffect(() => {
    if (!walking) {
      setPlayer(null);
      return;
    }
    const timer = window.setInterval(() => {
      const renderer = rendererRef.current;
      setPlayer(renderer?.localPosition() ?? null);
      // On the same tick, and only while walking — which is the only time either
      // map is on screen. A bike moves when somebody rides it, so unlike the
      // places this cannot be resolved once at build.
      setRides(renderer?.rides() ?? []);
    }, 180);
    return () => window.clearInterval(timer);
  }, [walking]);

  // The walker recomputes what is alongside every 200ms, so polling faster than
  // that re-reads an answer that has not changed, and polling at exactly that
  // rate would drift in and out of phase with it and double the worst wait. At
  // 100ms the lag this layer adds is bounded at a tenth of a second — under the
  // threshold where a prompt stops feeling attached to the step that earned it.
  // It costs ten string compares a second and nothing else: React bails out of
  // the render when the action has not changed, so walking the length of a deck
  // re-renders once on arrival and once on leaving.
  useEffect(() => {
    if (!walking) {
      setPrompt(null);
      return;
    }
    const timer = window.setInterval(() => setPrompt(rendererRef.current?.prompt() ?? null), 100);
    return () => window.clearInterval(timer);
  }, [walking]);

  const heading = useMemo<Heading>(() => {
    if (!player) return null;
    const remaining = pois.filter((poi) => !exploration.discovered.has(poi.id));
    if (remaining.length === 0) return null;

    let best = remaining[0]!;
    let bestDistance = Infinity;
    for (const poi of remaining) {
      const distance = Math.hypot(poi.x - player.x, poi.z - player.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = poi;
      }
    }

    // Bearing relative to where the walker faces, so the arrow points the way
    // the screen does rather than the way north does.
    const absolute = Math.atan2(best.x - player.x, best.z - player.z);
    return { poi: best, distance: bestDistance, bearing: player.yaw - absolute };
  }, [player, pois, exploration.discovered]);

  // Defaulted to dismissed so neither the server render nor the first client
  // render can show it; the effect opens it only once storage has been read.
  useEffect(() => {
    try {
      setNightDismissed(window.localStorage.getItem('otrip:night-seen') === '1');
    } catch {
      setNightDismissed(false);
    }
  }, []);

  const dismissNight = useCallback(() => {
    setNightDismissed(true);
    try {
      window.localStorage.setItem('otrip:night-seen', '1');
    } catch {
      // Private browsing: it reappears next visit, which is the safe way to err.
    }
  }, []);

  // Someone who opens a place to relax at eleven at night gets a near-unlit
  // frame and no sign that the hour can be moved. Only while the clock is
  // untouched: scrubbing to midnight on purpose needs no explanation, and the
  // slider has already been found.
  //
  // The line is the end of civil twilight, read off the sun's elevation rather
  // than off `daylight` — that is a clamped blend that still reads 0.15 at
  // roughly four degrees down, where the sky is a good dusk and telling someone
  // "trời đang tối" would be both wrong and a little insulting. Elevation is
  // also pure astronomy, from `solarPosition` and nothing else, so retuning how
  // night is lit cannot move when this fires.
  const brightIndex = sunriseIndex ?? goldenIndex;

  const nightNotice = useMemo(() => {
    if (!forecast || !sky || picked !== null || nightDismissed) return null;
    if (sky.sunElevation > -6) return null;

    const now = forecast.hours[nowIndex];
    const bright = brightIndex === null ? null : forecast.hours[brightIndex];
    if (!now) return null;

    const today = todayAt(forecast.utcOffsetSeconds);
    return {
      hour: formatHour(now.time, today),
      brightLabel: bright ? formatHour(bright.time, today) : null,
      aheadHours: forecast.hours.length - 1 - nowIndex,
    };
  }, [forecast, sky, picked, nightDismissed, nowIndex, brightIndex]);

  // Opens the hour panel on the way: someone who took this offer has just
  // learned the hour can be moved, and the slider is the next thing they want.
  const jumpToBright = useCallback(() => {
    if (brightIndex === null) return;
    select(brightIndex);
    setTab('sky');
    dismissNight();
  }, [brightIndex, select, dismissNight]);

  const takePhoto = useCallback(async () => {
    const capture = rendererRef.current?.capture;
    const hour = forecast?.hours[index];
    if (!capture) return;

    setPhotoLabel('Đang chụp…');
    try {
      const frame = capture(1600, 1000);
      const blob = await composePostcard(frame, {
        recipe,
        when: hour && forecast ? formatHour(hour.time, todayAt(forecast.utcOffsetSeconds)) : 'bây giờ',
        weather: hour ? `${weatherLabel(hour.weatherCode)} · ${Math.round(hour.temperature)}°C` : '',
        preset,
        cloudHunt: hour?.cloudHunt ?? null,
      });

      if (!blob) {
        setPhotoLabel('Không chụp được');
      } else {
        downloadPostcard(blob, `otrip-${recipe.slug}.png`);
        setPhotoLabel('Đã lưu ảnh');
      }
    } catch {
      setPhotoLabel('Không chụp được');
    }
    window.setTimeout(() => setPhotoLabel('Chụp ảnh'), 2200);
  }, [forecast, index, recipe, preset]);

  const remindMe = useCallback(() => {
    const hour = forecast?.hours[index];
    if (!forecast || !hour) return;

    const url = new URL(window.location.href);
    url.searchParams.set('luc', hour.time);
    downloadReminder(buildReminder(forecast, hour, recipe, url.toString()), `otrip-${recipe.slug}.ics`);
    setRemindLabel('Đã tải lịch');
    window.setTimeout(() => setRemindLabel('Nhắc tôi'), 2200);
  }, [forecast, index, recipe]);

  const travel = useCallback((destination: string | { x: number; z: number }) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (typeof destination === 'string') renderer.travelTo(destination);
    else renderer.travelToPosition(destination.x, destination.z);
    // The room is told by `onPlaced` below rather than from here. The renderer
    // announces every placement it makes, including the ones this component
    // never asked for — the walker a rebuilt world creates at a new detail
    // tier was the one that got missed, and it desynced the room silently.
  }, []);

  /**
   * Where the renderer put the player, as against where they walked. Fast travel
   * is an explicit action to the room, not a stream of impossible walk packets —
   * `handleMove` would refuse those on speed, and it refuses by returning, so
   * nobody would be told.
   */
  /**
   * Where the camera looks, read fresh on every frame the compass draws.
   *
   * Not `player`, which this component samples every 180 ms for the minimap: a
   * mouse turn covers 180° in a second, so an arrow drawn off a 180 ms sample
   * trails the very turn it exists to guide by a third of a turn. And not
   * `player.yaw` either, which is the body's heading — eased toward the
   * direction of travel, so on a strafe it is ninety degrees off where the
   * player is actually looking.
   */
  const viewpoint = useCallback(() => rendererRef.current?.localView() ?? null, []);

  const onPlaced = useCallback(
    (x: number, z: number) => {
      trip.relocate(x, z);
    },
    [trip.relocate]
  );

  const onLocalMove = useCallback(
    (move: LocalMove) => {
      if (trip.status === 'joined') {
        trip.move(move.x, move.z, move.yaw, {
          heading: move.heading,
          speed: move.speed,
          riding: move.riding,
        });
      }
    },
    [trip]
  );

  // On foot the panels are a menu, not a HUD: they are there when you ask for
  // them and gone when you are playing.
  const hudVisible = (!walking || menuOpen) && !panelsHidden;

  // A phone shows one panel at a time; from `sm` up all three fit side by side.
  // `contents` keeps each panel a direct flex child, so the row still sizes the
  // way it did before the tabs existed.
  const panelClass = (id: PanelTab) => (tab === id ? 'contents' : 'hidden sm:contents');

  const tripWarning =
    trip.status !== 'joined'
      ? null
      : trip.players.length === 0
        ? 'Đổi điểm đến sẽ rời chuyến đi hiện tại.'
        : `Đổi điểm đến sẽ rời chuyến đi với ${trip.players.length} người kia.`;

  return (
    <div className="relative h-[100svh] w-full overflow-hidden">
      <SceneCanvas
        recipe={recipe}
        sky={sky}
        weather={weather}
        walking={walking}
        remotePlayers={trip.players}
        joystick={joystick}
        onLocalMove={onLocalMove}
        onPlaced={onPlaced}
        rendererRef={rendererRef}
        style={settings.style}
        tier={settings.tier}
        sensitivity={settings.sensitivity}
        comfort={comfort}
        onLockChange={onLockChange}
      />

      {/* Arriving somewhere should say something, otherwise the beam was just a
          light you walked into. */}
      {exploration.justFound && (
        <div className="pointer-events-auto absolute top-6 left-1/2 w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 rounded-panel bg-panel/90 p-4 shadow-panel backdrop-blur-md">
          <p className="text-[0.65rem] tracking-wide text-accent uppercase">Đã tới</p>
          <p className="font-display text-lg">{exploration.justFound.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{exploration.justFound.note}</p>
          <button
            type="button"
            onClick={exploration.dismiss}
            className="mt-2 text-xs text-accent underline-offset-2 hover:underline"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Walking without the pointer captured is the state where the mouse does
          nothing and nobody knows why, so say what to do about it. */}
      {walking && !locked && hintVisible && !menuOpen && (
        <p className="pointer-events-none absolute inset-x-0 top-20 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-control bg-panel/70 px-4 py-2 text-center text-xs backdrop-blur-md">
          Kéo để nhìn quanh · nhấn vào cảnh để khoá chuột như game
        </p>
      )}

      {/* The hint used to be the only way back and it hid itself after seven
          seconds, which left anyone who collapsed the panels with no way out.
          This stays for as long as you are on foot, and is a button because a
          phone has no ESC key. */}
      {walking && !menuOpen && (
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="pointer-events-auto absolute top-4 left-4 flex min-h-11 items-center gap-2 rounded-control bg-panel/50 px-3 text-xs text-muted-foreground backdrop-blur-md transition-colors hover:bg-panel/90 hover:text-foreground sm:top-6 sm:left-6"
        >
          <span aria-hidden="true">☰</span>
          <span className="[@media(pointer:coarse)]:hidden">ESC · </span>Tạm dừng
        </button>
      )}

      {walking && menuOpen && (
        <button
          type="button"
          aria-label="Tiếp tục đi bộ"
          onClick={resume}
          className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[2px]"
        />
      )}

      {/* Browsing from the sky is the one place the panels are the point, so
          hiding them there needs its own way back. */}
      {!walking && panelsHidden && (
        <button
          type="button"
          onClick={() => setPanelsHidden(false)}
          className="pointer-events-auto absolute top-4 left-4 flex min-h-11 items-center rounded-control bg-panel/70 px-3 text-xs backdrop-blur-md hover:bg-panel/90 sm:top-6 sm:left-6"
        >
          Hiện bảng điều khiển
        </button>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-3 p-4 sm:p-6">
        <div className={cn('flex items-start justify-between gap-3', !hudVisible && 'invisible')}>
          <LocationCard recipe={recipe} />
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-start gap-2">
              <AudioControls audio={audio} />
              <SettingsPanel settings={settings} />
            </div>
            {/* `visible` against the row's own `invisible`: on foot the rest of
                the HUD steps aside for the world, but the map is how you know
                where you are, and having to press ESC to see it turned every
                glance at it into a pause. It still goes away with the H key,
                which is a choice rather than a side effect. */}
            {walking && !panelsHidden && (
              <div className="visible">
                <Minimap
                  relief={relief}
                  pois={pois}
                  rides={rides}
                  discovered={exploration.discovered}
                  player={player}
                  others={trip.players}
                  onOpen={() => setMapOpen(true)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Walking, this column *is* the pause menu: one scrollable card stack in
            the middle of the screen, which is also the only layout that fits a
            phone. Browsing, the panels stay a HUD at the bottom left. */}
        <div
          className={cn(
            'flex min-h-0 flex-col gap-3',
            !hudVisible && 'hidden',
            walking
              ? 'pointer-events-auto mx-auto w-[min(24rem,calc(100%-2rem))] overflow-y-auto overscroll-contain py-1'
              : 'items-center sm:items-start'
          )}
        >
          {walking && (
            <PauseMenu
              recipe={recipe}
              onResume={resume}
              onSightsee={() => setWalking(false)}
              tripWarning={tripWarning}
            />
          )}

          {/* Deliberately out here rather than in the pause menu: it has to
              reach someone who does not yet know there is a menu. */}
          {!walking && nightNotice && (
            <NightNotice
              name={recipe.name}
              hour={nightNotice.hour}
              aheadHours={nightNotice.aheadHours}
              brightLabel={nightNotice.brightLabel}
              onJump={jumpToBright}
              onDismiss={dismissNight}
            />
          )}

          <PanelTabs tab={tab} onChange={setTab} />

          {/* An opened panel scrolls inside a bounded box rather than growing
              until the scene is a strip at the top. The tab row sits outside
              it, so the way back out never scrolls away. */}
          <div
            className={cn(
              'flex w-full gap-3 overflow-y-auto overscroll-contain sm:max-h-none sm:overflow-visible',
              walking ? 'flex-col' : 'max-h-[55svh] flex-col sm:flex-row sm:items-end'
            )}
          >
            <div className={panelClass('sky')}>
              {forecast && (
                <SkyControls
                  recipe={recipe}
                  forecast={forecast}
                  index={index}
                  nowIndex={nowIndex}
                  goldenIndex={goldenIndex}
                  sunriseIndex={sunriseIndex}
                  onChange={select}
                  playing={playing}
                  onTogglePlay={togglePlay}
                  secondsPerHour={secondsPerHour}
                  onCycleSpeed={cycleSpeed}
                  onPlaySunrise={playSunrise}
                  onShare={share}
                  shareLabel={shareLabel}
                  onPhoto={() => void takePhoto()}
                  photoLabel={photoLabel}
                  onRemind={remindMe}
                  remindLabel={remindLabel}
                  onCollapse={() => (walking ? setMenuOpen(false) : setPanelsHidden(true))}
                />
              )}
              {forecast && (
                <WeatherPicker
                  value={preset}
                  onChange={choosePreset}
                  recipe={recipe}
                  sun={{ night, daylight: sky?.daylight ?? 0 }}
                  realLabel={realLabel}
                />
              )}
            </div>

            <div className={panelClass('explore')}>
              <ExplorePanel
                pois={pois}
                discovered={exploration.discovered}
                heading={heading}
                walking={walking}
                onWalk={() => setWalking(true)}
                onTravel={travel}
                onOpenMap={() => setMapOpen(true)}
              />
            </div>

            <div className={panelClass('trip')}>
              <TripPanel
                trip={trip}
                onStart={beginTrip}
                walking={walking}
                onToggleWalking={() => setWalking((value) => !value)}
                view={view}
                onToggleView={() => rendererRef.current?.toggleView()}
                onCopyInvite={copyInvite}
                inviteLabel={inviteLabel}
              />
            </div>
          </div>

          {error && (
            <p className="rounded-control bg-panel/60 px-3 py-2 text-xs text-muted-foreground backdrop-blur-md">
              {error} — đang hiện cảnh bình minh mặc định.
            </p>
          )}
        </div>

        {/* Outside the panel column so it survives both the pause menu and a
            collapsed HUD: what it offers is the thing you are standing in. */}
        {walking && !menuOpen && <ActionPrompt action={prompt} onInteract={() => rendererRef.current?.interact()} />}

        {/* Which way your friends are. The room will happily report "Bạn và 1
            người nữa" while the person is standing behind you and therefore
            nowhere on screen at all — measured, two travellers spawn 9 to 17 m
            apart facing a direction neither of them chose, and that turned out
            to be the whole of the "multiplayer doesn't work" report. */}
        {walking && !menuOpen && trip.players.length > 0 && (
          <CompanionCompass players={trip.players} view={viewpoint} />
        )}

        {/* The dash. A getter rather than a value, and read on its own animation
            frame: the speed changes sixty times a second and putting that in
            React state would re-render this whole subtree with it. It draws
            nothing on foot, so it can stay mounted. */}
        {walking && !menuOpen && <RideDash telemetry={() => rendererRef.current?.telemetry() ?? null} />}

        <div className="flex w-full items-end justify-between gap-3">
          {hudVisible ? <ControlHints walking={walking} /> : <span />}
          {/* The joystick is how a phone moves at all, so it outlives the menu. */}
          {walking && !menuOpen && <TouchJoystick onChange={setJoystick} />}
        </div>
      </div>

      <WorldMap
        open={mapOpen}
        onOpen={() => setMapOpen(true)}
        onClose={() => setMapOpen(false)}
        recipe={recipe}
        relief={relief}
        pois={pois}
        discovered={exploration.discovered}
        player={player}
        others={trip.players}
        routes={routes}
        rides={rides}
        onTravelTo={(x, z) => travel({ x, z })}
        onTravel={travel}
        canTravel={walking}
      />
    </div>
  );
};
