import type { LocationRecipe } from '@otrip/world';

import { drawOf } from '@/lib/draw';

/**
 * Two sets, swapped by pointer type in CSS rather than by JS, so the server
 * render is already correct: telling a phone to "right-drag" is nonsense.
 */
const POINTER_CONTROLS = [
  { key: 'Kéo', action: 'quay quanh' },
  { key: 'Cuộn', action: 'phóng to' },
  { key: 'Phải + kéo', action: 'dịch ngang' },
];

const TOUCH_CONTROLS = [
  { key: 'Chạm kéo', action: 'quay quanh' },
  { key: 'Chụm', action: 'phóng to' },
  { key: 'Hai ngón', action: 'dịch ngang' },
];

const ControlList = ({ controls, className }: { controls: typeof POINTER_CONTROLS; className: string }) => (
  <dl className={`flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs ${className}`}>
    {controls.map((control) => (
      <div key={control.key} className="flex gap-1.5">
        <dt className="font-semibold text-accent">{control.key}</dt>
        <dd className="text-muted-foreground">{control.action}</dd>
      </div>
    ))}
  </dl>
);

export const LocationCard = ({ recipe }: { recipe: LocationRecipe }) => (
  <div className="rounded-panel bg-panel/60 px-4 py-3 shadow-panel backdrop-blur-md sm:w-fit">
    <h1 className="font-display text-2xl leading-tight">{recipe.name}</h1>
    <p className="text-sm text-muted-foreground">{recipe.region}</p>
    <p className="mt-1 text-xs text-subtle">
      {recipe.coords.elevation}m · {drawOf(recipe).noun}
    </p>

    {/* The write-up used to be a band under the scene, which meant a page that
        scrolled away from the thing you came for. A details element keeps the
        text in the server-rendered DOM — the only prose a crawler can read here
        — while costing nothing on screen until someone asks for it. */}
    <details className="group pointer-events-auto mt-2 max-w-xs">
      {/* "Về nơi này" reads equally as "about this place" and "return to this
          place"; what it opens is the write-up, so it says so. */}
      <summary className="cursor-pointer list-none text-xs text-accent underline-offset-2 hover:underline">
        Giới thiệu nơi này
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{recipe.description}</p>
      <p className="mt-2 text-[0.65rem] text-subtle">
        {recipe.coords.lat}°N, {recipe.coords.lon}°E
      </p>
    </details>
  </div>
);

const WALK_POINTER_CONTROLS = [
  { key: 'W A S D', action: 'đi' },
  { key: 'Shift', action: 'chạy' },
  { key: 'Kéo / khoá chuột', action: 'nhìn quanh, ngẩng, cúi' },
  { key: 'Cuộn', action: 'xa gần' },
  { key: 'V', action: 'đổi ngôi' },
];

const WALK_TOUCH_CONTROLS = [
  { key: 'Cần gạt', action: 'đi' },
  { key: 'Chạm kéo', action: 'nhìn quanh, ngẩng, cúi' },
  { key: 'Chụm', action: 'xa gần' },
];

/** Hints follow the mode: orbit keys are useless while you are on foot. */
export const ControlHints = ({ walking = false }: { walking?: boolean }) => (
  <div className="rounded-control bg-panel/50 px-3 py-2 backdrop-blur-md">
    <ControlList
      controls={walking ? WALK_POINTER_CONTROLS : POINTER_CONTROLS}
      className="[@media(pointer:coarse)]:hidden"
    />
    <ControlList
      controls={walking ? WALK_TOUCH_CONTROLS : TOUCH_CONTROLS}
      className="hidden [@media(pointer:coarse)]:flex"
    />
  </div>
);
