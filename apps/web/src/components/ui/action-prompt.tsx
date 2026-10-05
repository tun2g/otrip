'use client';

type ActionPromptProps = {
  /** The action available where the walker stands, without a key, or null. */
  action: string | null;
  onInteract: () => void;
};

/**
 * Standing beside a boat used to say nothing at all. This is the one line that
 * tells you there is something to do, and on a phone — which has no E key — it
 * is also how you do it, so it is a button rather than a caption.
 *
 * The walker reports the action alone; the wording of how to take it belongs
 * here, because this is the only layer that knows what is in front of the
 * person. The two readings are swapped by pointer type in CSS rather than by
 * JS, the way the control hints are, so the first paint is already right.
 *
 * The live region is always mounted and the button comes and goes inside it:
 * a region that appears at the same moment as its text has nothing to compare
 * against, and screen readers routinely stay silent on it.
 */
export const ActionPrompt = ({ action, onInteract }: ActionPromptProps) => (
  <div
    aria-live="polite"
    className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center px-4 sm:bottom-28"
  >
    {action && (
      <button
        type="button"
        onClick={onInteract}
        className="pointer-events-auto flex min-h-11 items-center rounded-control border border-accent/60 bg-panel/80 px-4 text-sm text-accent shadow-panel backdrop-blur-md transition-colors hover:border-accent hover:bg-panel/95"
      >
        <span className="[@media(pointer:coarse)]:hidden">
          Nhấn <kbd className="mx-1 rounded border border-accent/50 px-1.5 py-0.5 font-sans text-xs text-accent">E</kbd>{' '}
          để {action}
        </span>
        <span className="hidden [@media(pointer:coarse)]:inline">Chạm để {action}</span>
      </button>
    )}
  </div>
);
