'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ResolvedPoi } from '@/scene/points-of-interest';

export type Exploration = {
  discovered: Set<string>;
  /** The place just found, for the card that slides in. Cleared on dismiss. */
  justFound: ResolvedPoi | null;
  ready: boolean;
  discover: (poi: ResolvedPoi) => void;
  dismiss: () => void;
  reset: () => void;
};

const keyFor = (slug: string) => `otrip:visited:${slug}`;

/**
 * Which places this visitor has already walked to, kept per destination in local
 * storage. Deliberately not on the server: there is no account, and a list of
 * four place names is not worth asking anyone to sign in for.
 */
export const useExploration = (slug: string): Exploration => {
  const [discovered, setDiscovered] = useState<Set<string>>(new Set());
  const [justFound, setJustFound] = useState<ResolvedPoi | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    try {
      const stored = JSON.parse(window.localStorage.getItem(keyFor(slug)) ?? '[]') as unknown;
      setDiscovered(new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []));
    } catch {
      setDiscovered(new Set());
    }
    setReady(true);
  }, [slug]);

  const persist = useCallback(
    (ids: Set<string>) => {
      try {
        window.localStorage.setItem(keyFor(slug), JSON.stringify([...ids]));
      } catch {
        // Nothing to do: the trip still works, it just will not be remembered.
      }
    },
    [slug]
  );

  const discover = useCallback(
    (poi: ResolvedPoi) => {
      setDiscovered((current) => {
        if (current.has(poi.id)) return current;
        const next = new Set(current).add(poi.id);
        persist(next);
        return next;
      });
      setJustFound(poi);
    },
    [persist]
  );

  const reset = useCallback(() => {
    setDiscovered(new Set());
    persist(new Set());
  }, [persist]);

  return { discovered, justFound, ready, discover, dismiss: () => setJustFound(null), reset };
};
