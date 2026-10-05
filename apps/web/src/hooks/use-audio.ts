'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createAudioEngine, type AmbienceLayer, type AudioEngine } from '@/lib/audio-engine';

export type AudioState = {
  started: boolean;
  loading: boolean;
  error: string | null;
  track: string | null;
  volume: number;
  start: () => void;
  next: () => void;
  setVolume: (value: number) => void;
};

/**
 * The engine is built inside `start`, not alongside the hook. Creating it up
 * front and disposing it in an effect cleanup meant React's development double
 * mount tore down the instance the next mount then reused: the button flipped to
 * "playing" while a disposed engine quietly refused to load a single file.
 */
export const useAudio = (ambienceNames: string[], musicNames: string[], layers: AmbienceLayer[]): AudioState => {
  const engineRef = useRef<AudioEngine | null>(null);
  const layersRef = useRef(layers);
  const volumeRef = useRef(0.7);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(0.7);

  layersRef.current = layers;

  useEffect(() => {
    engineRef.current?.setAmbience(layers);
  }, [layers]);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    []
  );

  const start = useCallback(() => {
    if (engineRef.current || loading) return;

    const engine = createAudioEngine(ambienceNames, musicNames);
    engineRef.current = engine;
    engine.setVolume(volumeRef.current);
    setLoading(true);

    engine
      .start()
      .then(() => {
        engine.setAmbience(layersRef.current);
        setStarted(true);
        setTrack(engine.currentTrack());
      })
      .catch((cause: unknown) => {
        engineRef.current = null;
        setError(cause instanceof Error ? cause.message : 'Không bật được tiếng');
      })
      .finally(() => setLoading(false));
  }, [ambienceNames, musicNames, loading]);

  const next = useCallback(() => {
    engineRef.current?.next();
    setTrack(engineRef.current?.currentTrack() ?? null);
  }, []);

  const setVolume = useCallback((value: number) => {
    volumeRef.current = value;
    setVolumeState(value);
    engineRef.current?.setVolume(value);
  }, []);

  return { started, loading, error, track, volume, start, next, setVolume };
};
