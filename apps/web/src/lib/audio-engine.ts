export type AmbienceLayer = {
  /** File name under /audio/ambience, without extension. */
  name: string;
  /** 0..1 target level for this layer right now. */
  gain: number;
};

export type AudioEngine = {
  /** Must be called from a user gesture; browsers refuse audio otherwise. */
  start: () => Promise<void>;
  setAmbience: (layers: AmbienceLayer[]) => void;
  setVolume: (value: number) => void;
  next: () => void;
  /** Track currently playing, or null before playback starts. */
  currentTrack: () => string | null;
  dispose: () => void;
};

const AMBIENCE_PATH = '/audio/ambience';
const MUSIC_PATH = '/audio/music';

/** Seconds trimmed off each end of a loop. */
const LOOP_TRIM = 0.06;
const FADE = 1.5;
const MUSIC_CROSSFADE = 3;

const load = async (context: AudioContext, url: string): Promise<AudioBuffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Không tải được ${url}`);
  return context.decodeAudioData(await response.arrayBuffer());
};

/**
 * One missing file used to take the whole soundscape down with it, because a
 * single rejection fails the `Promise.all` that loads the set. A destination
 * that names a bed nobody has recorded yet should lose that bed and nothing
 * else.
 */
const loadAll = async (
  context: AudioContext,
  path: string,
  names: string[]
): Promise<{ name: string; buffer: AudioBuffer }[]> => {
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, buffer: await load(context, `${path}/${name}.m4a`) };
      } catch {
        return null;
      }
    })
  );

  return results.filter((entry): entry is { name: string; buffer: AudioBuffer } => entry !== null);
};

/**
 * Web Audio rather than <audio> elements, because the ambience has to be mixed:
 * wind, birds and rain all run at once at levels the weather decides.
 *
 * Loop points are pulled a few milliseconds inside the buffer on purpose — AAC
 * carries encoder padding at both ends, and looping the raw buffer puts a click
 * in a track meant to be left running for an hour.
 */
export const createAudioEngine = (ambienceNames: string[], musicNames: string[]): AudioEngine => {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let disposed = false;
  let volume = 0.7;

  const ambience = new Map<string, { gain: GainNode; source: AudioBufferSourceNode }>();
  let pending: AmbienceLayer[] | null = null;

  let musicBuffers: AudioBuffer[] = [];
  /** Names of the tracks that actually loaded, so a skipped file cannot shift the label. */
  let trackNames: string[] = [];
  let musicIndex = 0;
  let musicSource: AudioBufferSourceNode | null = null;
  let musicGain: GainNode | null = null;
  let musicTimer: number | null = null;

  const playTrack = (index: number) => {
    if (!context || !master || musicBuffers.length === 0) return;

    const buffer = musicBuffers[index % musicBuffers.length];
    if (!buffer) return;

    musicIndex = index % musicBuffers.length;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(1, context.currentTime + MUSIC_CROSSFADE);
    gain.connect(master);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start();

    const previousSource = musicSource;
    const previousGain = musicGain;
    if (previousGain && context) {
      previousGain.gain.cancelScheduledValues(context.currentTime);
      previousGain.gain.setValueAtTime(previousGain.gain.value, context.currentTime);
      previousGain.gain.linearRampToValueAtTime(0, context.currentTime + MUSIC_CROSSFADE);
      window.setTimeout(() => previousSource?.stop(), MUSIC_CROSSFADE * 1000 + 200);
    }

    musicSource = source;
    musicGain = gain;

    if (musicTimer !== null) window.clearTimeout(musicTimer);
    musicTimer = window.setTimeout(
      () => playTrack(musicIndex + 1),
      Math.max(1000, (buffer.duration - MUSIC_CROSSFADE) * 1000)
    );
  };

  const applyAmbience = (layers: AmbienceLayer[]) => {
    if (!context) {
      pending = layers;
      return;
    }

    const wanted = new Map(layers.map((layer) => [layer.name, layer.gain]));

    for (const [name, node] of ambience) {
      const target = wanted.get(name) ?? 0;
      node.gain.gain.cancelScheduledValues(context.currentTime);
      node.gain.gain.setValueAtTime(node.gain.gain.value, context.currentTime);
      node.gain.gain.linearRampToValueAtTime(target, context.currentTime + FADE);
    }
  };

  return {
    start: async () => {
      if (context || disposed) return;

      context = new AudioContext();
      master = context.createGain();
      master.gain.value = volume;
      master.connect(context.destination);

      const ambienceBuffers = await loadAll(context, AMBIENCE_PATH, ambienceNames);

      if (disposed) return;

      for (const { name, buffer } of ambienceBuffers) {
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(master);

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = LOOP_TRIM;
        source.loopEnd = Math.max(LOOP_TRIM * 2, buffer.duration - LOOP_TRIM);
        source.connect(gain);
        source.start();

        ambience.set(name, { gain, source });
      }

      const music = await loadAll(context, MUSIC_PATH, musicNames);
      if (disposed) return;

      trackNames = music.map((entry) => entry.name);
      musicBuffers = music.map((entry) => entry.buffer);
      if (ambienceBuffers.length === 0 && musicBuffers.length === 0) throw new Error('Không tải được tiếng nào');

      playTrack(0);
      if (pending) applyAmbience(pending);
      pending = null;
    },

    setAmbience: applyAmbience,

    setVolume: (value) => {
      volume = Math.min(1, Math.max(0, value));
      if (context && master) {
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.linearRampToValueAtTime(volume, context.currentTime + 0.15);
      }
    },

    next: () => playTrack(musicIndex + 1),

    currentTrack: () => (musicBuffers.length === 0 ? null : (trackNames[musicIndex] ?? null)),

    dispose: () => {
      disposed = true;
      if (musicTimer !== null) window.clearTimeout(musicTimer);
      for (const node of ambience.values()) node.source.stop();
      ambience.clear();
      musicSource?.stop();
      void context?.close();
      context = null;
      master = null;
    },
  };
};
