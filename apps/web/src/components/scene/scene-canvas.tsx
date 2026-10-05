'use client';

import type { SkyState } from '@otrip/contracts';
import type { LocationRecipe } from '@otrip/world';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { RemotePlayer } from '@/scene/avatars';
import type { QualityTier, RenderStyle } from '@/scene/quality';
import type { Joystick } from '@/scene/walker';
import type { WorldWeather } from '@/scene/weather-state';
import type { LocalMove, WorldRenderer } from '@/scene/world-renderer';

type SceneStatus = 'loading' | 'ready' | 'unsupported';

/** The CC0 kit the scene scatters. Four hundred kilobytes, loaded once. */
const NATURE_MODELS = [
  'TreeHigh001',
  'TreeHigh002',
  'TreeHigh003',
  'TreeMed001',
  'TreeMed002',
  'TreeMed003',
  'TreeLow001',
  'TreeLow002',
  'TreeLow003',
  'TreeLow004',
  'Grass001',
  'Grass002',
  'Grass003',
  'Bush001',
  'Bush002',
  'Reed001',
  'Reed002',
  'Rock001',
  'Rock002',
  'Rock003',
];

type SceneCanvasProps = {
  recipe: LocationRecipe;
  sky?: SkyState;
  weather?: WorldWeather;
  walking: boolean;
  remotePlayers: RemotePlayer[];
  joystick: Joystick | null;
  onLocalMove?: (move: LocalMove) => void;
  /** Filled with the live renderer so the HUD can read and drive the scene. */
  rendererRef?: RefObject<WorldRenderer | null>;
  style: RenderStyle;
  tier: QualityTier;
  sensitivity: number;
  onLockChange?: (locked: boolean) => void;
};

export const SceneCanvas = ({
  recipe,
  sky,
  weather,
  walking,
  remotePlayers,
  joystick,
  onLocalMove,
  rendererRef,
  style,
  tier,
  sensitivity,
  onLockChange,
}: SceneCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [renderer, setRenderer] = useState<WorldRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let dispose: (() => void) | undefined;

    // Three.js, the generator and the model kit are all client-only. They load
    // together so the first frame already has its trees and grass rather than
    // popping them in a second later.
    Promise.all([
      import('@/scene/world-renderer'),
      import('@/scene/model-loader').then((module) => module.loadNature(NATURE_MODELS)),
      import('@/scene/human').then((module) => module.loadHuman().catch(() => undefined)),
    ])
      .then(([{ createWorldRenderer }, sources, humanSource]) => {
        if (disposed) return;
        const instance = createWorldRenderer(canvas, recipe, tier, style, sources, humanSource);
        dispose = instance.dispose;
        setRenderer(instance);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        // Swallowing this made a broken shader look like an old browser, which
        // sent the reader off debugging the wrong thing entirely.
        console.error('[otrip] scene failed to start', cause);
        setStatus('unsupported');
      });

    return () => {
      disposed = true;
      setRenderer(null);
      dispose?.();
    };
    // Tier changes the generated geometry, so it rebuilds; style and
    // sensitivity are applied live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, tier]);

  useEffect(() => {
    if (renderer && sky && weather) renderer.applySky(sky, weather);
  }, [renderer, sky, weather]);

  useEffect(() => {
    renderer?.setWalking(walking);
  }, [renderer, walking]);

  useEffect(() => {
    renderer?.setStyle(style);
  }, [renderer, style]);

  useEffect(() => {
    renderer?.setSensitivity(sensitivity);
  }, [renderer, sensitivity]);

  useEffect(() => {
    renderer?.onLockChange(onLockChange ?? null);
    return () => renderer?.onLockChange(null);
  }, [renderer, onLockChange]);

  useEffect(() => {
    renderer?.setRemotePlayers(remotePlayers);
  }, [renderer, remotePlayers]);

  useEffect(() => {
    renderer?.setJoystick(joystick);
  }, [renderer, joystick]);

  useEffect(() => {
    renderer?.onLocalMove(onLocalMove ?? null);
    return () => renderer?.onLocalMove(null);
  }, [renderer, onLocalMove]);

  useEffect(() => {
    if (!rendererRef) return;
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
    };
  }, [renderer, rendererRef]);

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      {status !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center bg-background">
          <p className="max-w-xs px-6 text-center text-sm text-muted-foreground">
            {status === 'loading'
              ? 'Đang mở đường lên núi…'
              : 'Máy hoặc trình duyệt này chưa xem được cảnh 3D. Thử mở bằng Chrome, Safari hoặc Edge bản mới nhé.'}
          </p>
        </div>
      )}
    </>
  );
};
