'use client';

import { useCallback, useRef, useState } from 'react';

import type { Joystick } from '@/scene/walker';

const RADIUS = 46;

/**
 * Walking needs a left hand on a phone. Shown only on touch pointers, because a
 * mouse already has WASD and a thumb pad in the corner of a desktop window is
 * just clutter.
 */
export const TouchJoystick = ({ onChange }: { onChange: (input: Joystick | null) => void }) => {
  const padRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

  const update = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;

      const bounds = pad.getBoundingClientRect();
      const dx = clientX - (bounds.left + bounds.width / 2);
      const dy = clientY - (bounds.top + bounds.height / 2);
      const distance = Math.min(RADIUS, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);

      const x = Math.cos(angle) * (distance / RADIUS);
      const y = Math.sin(angle) * (distance / RADIUS);

      setKnob({ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });
      // Screen down is forward-negative, hence the sign flip on Y.
      onChange({ x, y: -y });
    },
    [onChange]
  );

  const release = useCallback(() => {
    setKnob(null);
    onChange(null);
  }, [onChange]);

  return (
    <div
      ref={padRef}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX, event.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      role="application"
      aria-label="Cần điều khiển di chuyển"
      className="pointer-events-auto hidden size-28 touch-none place-items-center rounded-full border border-border bg-panel/50 backdrop-blur-md [@media(pointer:coarse)]:grid"
    >
      <div
        className="size-12 rounded-full bg-accent/70 transition-transform"
        style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined}
      />
    </div>
  );
};
