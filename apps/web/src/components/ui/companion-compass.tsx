'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemotePlayer } from '@/scene/avatars';
import { colourFor, relativeTo } from '@/scene/companion-markers';

/** Where the camera is and which way it looks, in the walker's yaw convention. */
export type Viewpoint = { x: number; z: number; yaw: number };

type CompanionCompassProps = {
  /** Everyone else in the room, exactly as the room reports them. */
  players: RemotePlayer[];
  /**
   * Read every frame rather than passed as a value. The camera yaw is the fast
   * term here — a mouse turn covers 180° in a second — and `location-scene.tsx`
   * samples the walker every 180 ms for the minimap, which would leave the arrow
   * trailing the very turn it is there to guide by a third of a turn.
   */
  view: () => Viewpoint | null;
};

/** No more than this many arrows. Past it they stop being a glance and become a list. */
const MAX_CHIPS = 4;

/**
 * How far off straight ahead still counts as "you are looking at them", in
 * radians.
 *
 * The renderer holds a constant horizontal field of view by widening the
 * vertical one below 16:9, so the horizontal half-angle is 40.9° on any desktop
 * shape; it only narrows once the vertical FOV hits its 88° clamp, which happens
 * below an aspect of 0.898 and bottoms out at 24.0° on a 390×844 phone held
 * upright. So 0.38 rad is 21.8°, inside the frame on the narrowest screen the
 * app has — an arrow that vanishes while its subject is still off the edge of a
 * phone would be the one failure this component exists to prevent.
 */
const AHEAD = 0.38;

/**
 * And how close, in metres. Measured: a companion at 16.75 m is 88 px tall with
 * a legible name, and at 60 m the same figure is about 27 px on the 1080 px
 * reference frame — still plainly a person. Beyond that the arrow earns its
 * place again even when they are dead ahead, because a speck on a hillside is
 * not an answer to "where are they".
 */
const CLOSE = 60;

/** Per second, so an arrow appearing as you turn away eases rather than blinks. */
const FADE = 7;

/**
 * Which way to turn, in words, for the live region and for the trip panel's
 * roster. `bearing` is clockwise from straight ahead, so positive is right.
 *
 * The cuts are the eight points of a compass rose folded in half: ±22.5° is
 * "ahead", and each 45° sector after it gets its own phrase. Deliberately coarse
 * — nobody turns by degrees, and "phía sau bên phải" is the instruction.
 */
export const directionWords = (bearing: number): string => {
  const away = Math.abs(bearing);
  const side = bearing > 0 ? 'phải' : 'trái';
  if (away <= 0.39) return 'ngay trước mặt';
  if (away >= 2.75) return 'ngay phía sau';
  if (away <= 1.18) return `chéo trước bên ${side}`;
  if (away <= 1.96) return `bên ${side}`;
  return `chéo sau bên ${side}`;
};

/**
 * How far, in words. Rounded to the metre under a hundred rather than to ten the
 * way the map and the name labels do: at this range the difference between 9 m
 * and 17 m is the difference between "they are right there" and "take a few
 * steps", and rounding both to 10 m throws exactly that away.
 */
export const companionDistance = (metres: number): string => {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  if (metres >= 100) return `${Math.round(metres / 10) * 10} m`;
  return `${Math.round(metres)} m`;
};

type Chip = { arrow: HTMLElement; metres: HTMLElement; row: HTMLElement };

/**
 * Which way to turn to see the people you came with.
 *
 * A user reported that multiplayer did not work: same room, no sign of the other
 * character. The avatar turned out to be drawn correctly — 88 px tall, named,
 * 16.75 m away — and the thing that was actually missing is this. A companion
 * spawns 9–17 m off in any direction, the arrival facing is chosen to look
 * downhill rather than at your friend, and nothing on screen said to turn
 * around: the name label is the one element drawn through walls, and under 70 m
 * it carries the bare name with no bearing and no distance. The minimap cannot
 * help, because it shows a whole 3.6–5.2 km terrain in 140 px, which puts a
 * companion at 9 m a quarter of a pixel from you and underneath your own marker.
 *
 * So: one chip per companion, each an arrow in that person's own colour, the
 * same colour their body and their ring carry. It fades out for anyone plainly
 * on screen, because an arrow pointing at someone you are looking at is clutter.
 *
 * The arrows are driven by `requestAnimationFrame` writing transforms straight
 * to the nodes rather than by React state. A turn is 60 updates a second and
 * this sits inside the scene's own tree: re-rendering that tree per frame to
 * rotate a glyph would cost more than the scene does.
 */
export const CompanionCompass = ({ players, view }: CompanionCompassProps) => {
  const chips = useRef(new Map<string, Chip>());
  /** Eased visibility per person, kept out of `chips` so ref churn cannot reset it. */
  const shown = useRef(new Map<string, number>());
  const blockRef = useRef<HTMLDivElement | null>(null);
  const roster = useRef(players);
  const [spoken, setSpoken] = useState('');

  useEffect(() => {
    roster.current = players;
  }, [players]);

  // Stable, so React never detaches a ref just because a position arrived: the
  // id travels on the node instead of in the closure.
  const attach = useCallback((row: HTMLLIElement | null) => {
    const id = row?.dataset.companion;
    const arrow = row?.querySelector<HTMLElement>('[data-arrow]');
    const metres = row?.querySelector<HTMLElement>('[data-metres]');
    if (!row || !id || !arrow || !metres) return;

    chips.current.set(id, { row, arrow, metres });
    return () => {
      chips.current.delete(id);
      shown.current.delete(id);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      const ease = 1 - Math.exp(-delta * FADE);
      const viewer = view();
      const people = roster.current;
      let loudest = 0;

      for (const [id, chip] of chips.current) {
        let found: RemotePlayer | null = null;
        // A hand-rolled scan rather than `find`: this runs sixty times a second
        // per companion, and a closure per chip per frame is garbage for nothing.
        for (let at = 0; at < people.length; at += 1) {
          if (people[at]!.id === id) found = people[at]!;
        }

        const placed = found !== null && Number.isFinite(found.x) && Number.isFinite(found.z);
        if (!viewer || !placed) {
          chip.row.style.opacity = '0';
          shown.current.set(id, 0);
          continue;
        }

        const { range, bearing } = relativeTo(viewer, found!);
        const want = Math.abs(bearing) <= AHEAD && range <= CLOSE ? 0 : 1;
        const was = shown.current.get(id) ?? 0;
        const level = was + (want - was) * ease;
        shown.current.set(id, level);
        loudest = Math.max(loudest, level);

        chip.row.style.opacity = level.toFixed(3);
        chip.arrow.style.transform = `rotate(${bearing}rad)`;
        const reading = companionDistance(range);
        if (chip.metres.textContent !== reading) chip.metres.textContent = reading;
      }

      // The heading and the overflow line have nothing of their own to fade
      // against, so they ride the loudest arrow: with everybody in front of you
      // the whole block goes, rather than leaving a caption over nothing.
      if (blockRef.current) blockRef.current.style.opacity = loudest.toFixed(3);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [view]);

  // The spoken line is its own slow loop. A screen reader given a distance that
  // changes every frame reads nothing else all walk, so only the direction is
  // announced, and only when it changes sector.
  useEffect(() => {
    const speak = () => {
      const viewer = view();
      const people = roster.current;
      if (!viewer || people.length === 0) {
        setSpoken('');
        return;
      }

      let nearest: RemotePlayer | null = null;
      let closest = Infinity;
      let words = '';
      for (const person of people) {
        if (!Number.isFinite(person.x) || !Number.isFinite(person.z)) continue;
        const { range, bearing } = relativeTo(viewer, person);
        if (range >= closest) continue;
        closest = range;
        nearest = person;
        words = directionWords(bearing);
      }

      setSpoken(nearest ? `${nearest.name} ở ${words}` : '');
    };

    speak();
    const timer = window.setInterval(speak, 600);
    return () => window.clearInterval(timer);
  }, [view]);

  const visible = players.slice(0, MAX_CHIPS);
  const extra = players.length - visible.length;

  return (
    // Always mounted, with the chips coming and going inside it: a live region
    // that appears at the same moment as its text has nothing to compare against
    // and screen readers routinely stay silent on it. Under the pause button
    // rather than beside the minimap, which is the other top corner, and far
    // from the joystick in the third.
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-[4.25rem] left-4 w-[min(13rem,calc(100%-2rem))] sm:top-[4.75rem] sm:left-6"
    >
      <span className="sr-only">{spoken}</span>

      {visible.length > 0 && (
        <div ref={blockRef} aria-hidden="true" style={{ opacity: 0 }}>
          <p className="px-1 text-[0.65rem] tracking-wide text-subtle uppercase">Người đi cùng</p>
          <ul className="mt-1 flex flex-col gap-1">
            {visible.map((person) => (
              <li
                key={person.id}
                ref={attach}
                data-companion={person.id}
                style={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-control bg-panel/70 px-2 py-1 text-xs shadow-panel backdrop-blur-md"
              >
                <span
                  data-arrow
                  className="inline-block text-base leading-none"
                  style={{ color: colourFor(person.id) }}
                >
                  ↑
                </span>
                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                <span data-metres className="shrink-0 text-[0.7rem] text-muted-foreground" />
              </li>
            ))}
            {extra > 0 && <li className="px-2 text-[0.7rem] text-subtle">+{extra} người nữa</li>}
          </ul>
        </div>
      )}
    </div>
  );
};
