'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

/*
 * Down to the matching marker: pure arithmetic, no imports, because
 * `probe/ride-dash-readout.ts` cuts the file at these two lines and runs the slice
 * alone — Node cannot import a `.tsx` and cannot strip JSX.
 *
 * `speed` and `topSpeed` are m/s up the nose, a negative speed being the rider
 * paddling it backwards; `slip` is radians the velocity lies off the nose; the
 * slides are 0..1 of each axle's grip spent; `grade` is metres risen per metre
 * travelled. Null on foot or afloat. The object is reused and refilled on the call,
 * which `probe/ride-dash.ts` asserts, so each field is read out inside the frame
 * that read it and nothing here keeps the reference.
 */
export type RideTelemetry = {
  speed: number;
  topSpeed: number;
  throttle: number;
  brake: number;
  handbrake: number;
  boost: number;
  boosting: number;
  slip: number;
  frontSlide: number;
  rearSlide: number;
  grade: number;
  noun: string;
  /** Which gear, from 1, and how many there are. */
  gear: number;
  gears: number;
  /** Engine speed, 0 to 1 of the rev range; 1 is the limiter and `POWER_BAND`
   *  is where the power is. Pre-normalised by `walker.ts`. */
  engine: number;
  /** Clutch out mid-shift — the one moment the throttle does nothing. */
  shifting: boolean;
  auto: boolean;
};

/**
 * Thresholds lifted from the driving model, not chosen, so what the dash calls a drift
 * is exactly what charges the meter. Full scale is `topSpeed * OVER_RANGE`, putting
 * `topSpeed` at `TOP_MARK` on the sweep; over 1 because `driving.ts` lifts the governor
 * by `BOOST_TOP` 3 m/s and power by 1.6 (a Wave's 23.6 m/s measured becoming 27.99)
 * under `driving-state.ts`'s `ABSOLUTE_TOP` 29, the fastest `speed` that can arrive —
 * which 1.25 clears either way `topSpeed` is read, at 0.983 of the sweep against 23.6
 * and 0.928 against the 25 m/s `tuneDrive().limit` governor.
 * `ARC_LENGTH` is π·46, the semicircle's own length, rather than `pathLength`, which a
 * browser ignoring it turns into a one-unit dotted line. `DRIFT_SLIP`/`DRIFT_FULL` are
 * `driving.ts`'s 0.10 rad (5.7°) and 0.45 (26°). `AXLE_MARGIN` is the gap before the
 * dash names one end rather than both, needed only for a neutral slide: a handbrake
 * stab pins `rearSlide` to `HANDBRAKE_BITE` 0.8 at once. Under `GRADE_FLOOR` the
 * gradient is terrain noise; `REVERSE_FLOOR` sits inside `REVERSE_MAX` 4 m/s, a rider
 * with a foot down. `BOOST_ARM` arms the button.
 */
const OVER_RANGE = 1.25;
const TOP_MARK = 1 / OVER_RANGE;
const ARC_LENGTH = Math.PI * 46;
const DRIFT_SLIP = 0.1;
const DRIFT_FULL = 0.45;
const AXLE_MARGIN = 0.12;
const GRADE_FLOOR = 0.03;
const REVERSE_FLOOR = 0.3;
const BOOST_ARM = 0.25;

const clamp01 = (value: number): number => (Number.isFinite(value) ? (value < 0 ? 0 : value > 1 ? 1 : value) : 0);
/**
 * km/h, whole, unsigned: every other figure this app shows a traveller is in the unit
 * they read off a sign, and reverse is named in words rather than with a minus.
 */
export const readSpeed = (speed: number): number => (Number.isFinite(speed) ? Math.round(Math.abs(speed) * 3.6) : 0);
/** Fraction of the arc that is lit. Reverse parks the needle at zero. */
export const sweep = (speed: number, topSpeed: number): number =>
  !Number.isFinite(speed) || !Number.isFinite(topSpeed) || topSpeed <= 0 ? 0 : clamp01(speed / (topSpeed * OVER_RANGE));

export const dashOffset = (lit: number): number => ARC_LENGTH * (1 - clamp01(lit));
/** Any pedal, meter or axle figure, as its own bar's scale. */
export const meter = (value: number): number => clamp01(value);
/** 0 until a slide counts as a drift, 1 once it is properly sideways. */
export const driftLevel = (slip: number): number =>
  Number.isFinite(slip) ? clamp01((Math.abs(slip) - DRIFT_SLIP) / (DRIFT_FULL - DRIFT_SLIP)) : 0;
/** The gradient as the percentage a road sign carries, capped so a cliff cannot widen the panel. */
export const readGrade = (grade: number): string =>
  !Number.isFinite(grade) || Math.abs(grade) < GRADE_FLOOR
    ? ''
    : `${grade > 0 ? '↗' : '↘'} ${Math.min(99, Math.round(Math.abs(grade) * 100))}%`;
type StateRead = { text: string; drift: boolean; level: number };
/**
 * What the machine is doing, and how loudly. A front wash and a rear step-out want
 * different recoveries, so it names the end that went; reverse shares the line, being
 * the other thing the arc cannot show. `level` rides the drift, floored because a word
 * at 0.1 opacity is no word.
 */
export const readState = (slip: number, frontSlide: number, rearSlide: number, speed: number): StateRead => {
  const sliding = driftLevel(slip);
  if (sliding > 0) {
    const front = clamp01(frontSlide);
    const rear = clamp01(rearSlide);
    const level = 0.4 + 0.6 * sliding;
    if (rear > front + AXLE_MARGIN) return { text: 'Bánh sau trượt', drift: true, level };
    if (front > rear + AXLE_MARGIN) return { text: 'Bánh trước trượt', drift: true, level };
    return { text: 'Trượt cả hai bánh', drift: true, level };
  }
  if (Number.isFinite(speed) && speed < -REVERSE_FLOOR) return { text: 'Đang lùi', drift: false, level: 1 };
  return { text: '', drift: false, level: 0 };
};

/** Three states, not four: charging gets no word, because the bar filling is the word. */
export const readBoost = (boost: number, boosting: number): string => {
  if (clamp01(boosting) > 0.05) return 'đang vọt';
  const level = clamp01(boost);
  if (level >= 0.999) return 'đầy';
  return level >= BOOST_ARM ? 'sẵn' : '';
};

/**
 * What a screen reader is told, polled slowly and spoken only on change, quantised
 * because a speed read to the unit changes on nearly every poll. Only a slide and a
 * full meter — the mechanic the dash exists to teach — are worth interrupting for.
 */
/**
 * Where the power is, as a share of the rev range.
 *
 * `driving-tuning.ts` puts peak power at 0.87 of the limiter and peak torque at
 * 0.65, so the band between them is the part of the range worth being in. The
 * dash shades it rather than labelling it: a rider who can see the needle enter
 * a band learns where to shift without being told, which is the same reason the
 * drift word appears at exactly `DRIFT_SLIP` and the boost notch sits at exactly
 * `BOOST_ARM`.
 */
export const POWER_BAND = 0.87;

/** The gear, as a rider counts it, with the box's own mode beside it. */
export const readGear = (gear: number, gears: number, auto: boolean): string => {
  if (!Number.isFinite(gear) || !Number.isFinite(gears) || gears < 1) return '';
  const at = Math.min(Math.max(Math.round(gear), 1), Math.round(gears));
  return `${at}/${Math.round(gears)} ${auto ? 'TỰ' : 'TAY'}`;
};

const SPEAK_STEP = 5;
export const spoken = (ride: RideTelemetry): string => {
  const rounded = Math.round(readSpeed(ride.speed) / SPEAK_STEP) * SPEAK_STEP;
  const state = readState(ride.slip, ride.frontSlide, ride.rearSlide, ride.speed);
  const words = [`${state.text === 'Đang lùi' ? 'lùi ' : ''}${rounded} km/h`];
  if (state.drift) words.push(state.text.toLowerCase());
  if (readBoost(ride.boost, ride.boosting) === 'đầy') words.push('đủ đà');
  return words.filter(Boolean).join(' · ');
};

/* ——— end of the sliced arithmetic; everything below needs React ——— */
/** Per second, so the drift line eases in rather than strobing at the threshold. */
const FADE = 9;
/** Milliseconds between checks while nobody rides, and between spoken lines. */
const IDLE_POLL = 250;
const SPEAK_EVERY = 1500;
/**
 * A semicircle of radius 46 about (56, 54), and the `topSpeed` mark at `TOP_MARK` of
 * a 180° sweep starting at 180° — 36° above the right-hand horizontal, from radius 41
 * out to 51 so it crosses the 4-wide track rather than floating beside it.
 */
const SWEEP = { d: 'M 10 54 A 46 46 0 0 1 102 54', fill: 'none', strokeWidth: 4, strokeLinecap: 'round' } as const;
const MARK = { x1: 89.17, y1: 29.9, x2: 97.26, y2: 24.02 };
/**
 * A full meter is the only animation, and `motion-safe` drops it for free: the ring
 * and the word "đầy" say the same thing standing still. Data-driven movement is never
 * gated — a dash that will not move is not a dash — and none of it moves the horizon,
 * which is what `cameraMotion` in `use-settings.ts` is actually for.
 */
const BAR = 'relative mt-0.5 h-1.5 overflow-hidden rounded-full bg-border-strong/70';
const BOOST_FULL = `${BAR} ring-1 ring-haze motion-safe:animate-pulse`;
const HAZE = 'var(--color-haze)';
/** A named bar with its reading beside the name, so both rows line up by construction. */
const Gauge = ({ left, right, children }: { left: string; right: ReactNode; children: ReactNode }) => (
  <div className="mt-1.5 text-[0.6rem] leading-none text-subtle">
    <p className="flex justify-between">
      <span>{left}</span>
      {right}
    </p>
    {children}
  </div>
);

/**
 * Speed, throttle, brake and the boost meter — none of which was visible before, so a
 * rider could not see their speed, could not see the boost they had earned, and could
 * not tell a slide from a tidy corner. One small block and not a cockpit:
 * `location-scene.tsx` records that "on foot the panels are a menu, not a HUD", and a
 * dash over the Hội An lanterns would be the wrong one. So: a numeral readable without
 * looking at it, an arc for how much is left, one bar that is throttle right of centre
 * and brake left — faithful rather than tidy, since `walker.ts` shuts the throttle
 * whenever the brake is on — and the meter under it. Haze, the cold token, always
 * means boost: the meter burning, and the arc past the `topSpeed` mark, the only way
 * past it. White on the brake side is a locked rear, which recovers differently. Run
 * through one container ref by `requestAnimationFrame`, as `companion-compass.tsx`
 * drives its arrows: telemetry in React state re-renders the scene subtree per frame.
 */
export const RideDash = ({ telemetry }: { telemetry: () => RideTelemetry | null }) => {
  const root = useRef<HTMLDivElement | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const block = root.current;
    if (!block) return;
    const pick = (name: string) => block.querySelector<HTMLElement>(`[data-${name}]`);
    const [lit, digits, state, noun, grade] = ['lit', 'digits', 'state', 'noun', 'grade'].map(pick);
    const [gas, stop, charge, track, word] = ['gas', 'stop', 'charge', 'track', 'word'].map(pick);
    const [revs, gear, gearRow] = ['revs', 'gear', 'gear-row'].map(pick);
    if (!lit || !digits || !state || !noun || !grade || !gas || !stop || !charge || !track || !word) return;
    if (!revs || !gear || !gearRow) return;

    // Here rather than in the markup: the block paints at opacity 0 and lights only
    // once a frame has written the offset, so no frame shows a full arc.
    lit.style.strokeDasharray = String(ARC_LENGTH);

    let frame = 0;
    let idle = 0;
    let last = performance.now();
    /** Eased loudness of the drift line, out of the DOM so a read is free. */
    let shown = 0;

    const set = (node: Element, text: string) => {
      if (node.textContent !== text) node.textContent = text;
    };

    const tick = () => {
      const now = performance.now();
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      const ride = telemetry();
      // On foot, and genuinely idle rather than early-returning sixty times a
      // second. A quarter second is quick enough that nobody sees it arrive.
      if (!ride) {
        block.style.opacity = '0';
        idle = window.setTimeout(tick, IDLE_POLL);
        return;
      }

      frame = requestAnimationFrame(tick);
      block.style.opacity = '1';
      const fraction = sweep(ride.speed, ride.topSpeed);
      lit.style.strokeDashoffset = dashOffset(fraction).toFixed(2);
      lit.style.stroke = fraction > TOP_MARK ? HAZE : 'var(--color-accent)';
      set(digits, String(readSpeed(ride.speed)));
      set(noun, ride.noun);
      set(grade, readGrade(ride.grade));
      const locked = meter(ride.handbrake);
      gas.style.transform = `scaleX(${meter(ride.throttle).toFixed(3)})`;
      stop.style.transform = `scaleX(${Math.max(meter(ride.brake), locked).toFixed(3)})`;
      stop.style.background = locked > 0.05 ? 'var(--color-foreground)' : 'var(--color-accent-strong)';
      const burning = meter(ride.boosting) > 0.05;
      const boost = readBoost(ride.boost, ride.boosting);
      charge.style.transform = `scaleX(${meter(ride.boost).toFixed(3)})`;
      charge.style.background = burning ? HAZE : 'var(--color-accent-strong)';
      track.className = boost === 'đầy' ? BOOST_FULL : BAR;
      set(word, boost);
      word.style.color = burning ? HAZE : 'var(--color-accent)';
      revs.style.transform = `scaleX(${meter(ride.engine).toFixed(3)})`;
      // Haze is boost everywhere else on this dash, and it is the same promise
      // here: haze means the machine is giving everything it has.
      revs.style.background = ride.engine >= POWER_BAND ? HAZE : 'var(--color-accent-strong)';
      set(gear, readGear(ride.gear, ride.gears, ride.auto));
      // The clutch is out: no drive and no engine braking, and the one moment a
      // throttle reading would be a lie. Dimming the row says so without a word.
      gearRow.style.opacity = ride.shifting ? '0.35' : '1';
      const reading = readState(ride.slip, ride.frontSlide, ride.rearSlide, ride.speed);
      set(state, reading.text);
      state.style.color = reading.drift ? 'var(--color-accent-strong)' : 'var(--color-subtle)';
      shown += (reading.level - shown) * (1 - Math.exp(-delta * FADE));
      state.style.opacity = shown.toFixed(3);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(idle);
    };
  }, [telemetry]);

  useEffect(() => {
    const speak = () => {
      const ride = telemetry();
      setSaid(ride ? spoken(ride) : '');
    };
    speak();
    const timer = window.setInterval(speak, SPEAK_EVERY);
    return () => window.clearInterval(timer);
  }, [telemetry]);

  return (
    // Lower left, clear of the rest by arithmetic rather than by eye: the action
    // prompt is `bottom-24` plus its own 44 px minimum, so 140 px up on a phone and
    // 156 px on a desktop, with the hints and joystick below that again; the compass
    // has the top left, the minimap the top right. The live region stays mounted and
    // the block fades inside it — one appearing with its first text is ignored.
    <div aria-live="polite" className="pointer-events-none absolute bottom-36 left-4 w-40 sm:bottom-40 sm:left-6">
      <span className="sr-only">{said}</span>
      <div
        ref={root}
        aria-hidden="true"
        style={{ opacity: 0 }}
        className="rounded-panel bg-panel/70 px-3 py-2 shadow-panel backdrop-blur-md"
      >
        <p className="flex items-baseline justify-between text-[0.6rem] leading-none">
          <span data-noun className="tracking-wide text-subtle uppercase" />
          <span data-grade className="text-subtle tabular-nums" />
        </p>
        <div className="relative mt-1 h-[4.25rem]">
          <svg viewBox="0 0 112 60" className="absolute inset-0 h-full w-full">
            <path {...SWEEP} stroke="var(--color-border-strong)" />
            <path {...SWEEP} data-lit stroke="var(--color-accent)" />
            {/* Where the throttle's own top is; past it the arc is haze. */}
            <line {...MARK} stroke={HAZE} strokeWidth={2} strokeLinecap="round" />
          </svg>
          <p className="absolute inset-x-0 bottom-0 flex items-baseline justify-center gap-1">
            <span data-digits className="font-display text-[1.75rem] leading-none tabular-nums" />
            <span className="text-[0.6rem] text-subtle">km/h</span>
          </p>
        </div>
        {/* Fixed height, so the block never changes shape when a slide starts. */}
        <p data-state className="h-3.5 text-center text-[0.65rem] leading-[0.875rem]" style={{ opacity: 0 }} />
        <Gauge left="phanh" right={<span>ga</span>}>
          <div className={BAR}>
            <span data-stop className="absolute inset-y-0 right-1/2 w-1/2 origin-right rounded-full" />
            <span data-gas className="absolute inset-y-0 left-1/2 w-1/2 origin-left rounded-full bg-accent" />
          </div>
        </Gauge>
        <div data-gear-row>
          <Gauge left="số" right={<span data-gear className="text-subtle tabular-nums" />}>
            <div className={BAR}>
              <span data-revs className="absolute inset-0 origin-left rounded-full" />
              {/* Where the power is. Past it the bar is haze and the next gear
                  is the answer, which is the whole of what a tacho is for. */}
              <span className="absolute inset-y-0 w-px bg-background/80" style={{ left: `${POWER_BAND * 100}%` }} />
            </div>
          </Gauge>
        </div>
        <Gauge left="đà" right={<span data-word className="text-accent" />}>
          <div data-track className={BAR}>
            <span data-charge className="absolute inset-0 origin-left rounded-full" />
            {/* The notch at a quarter: under it the button does nothing, and a
                meter refusing without saying why fails to teach itself. */}
            <span className="absolute inset-y-0 left-1/4 w-px bg-background/80" />
          </div>
        </Gauge>
      </div>
    </div>
  );
};
