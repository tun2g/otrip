'use client';

type NightNoticeProps = {
  /** Where you are, and what the clock says there right now. */
  name: string;
  hour: string;
  /**
   * Forecast hours still ahead of now. Passed in rather than written as 48: the
   * window runs from the destination's midnight to the end of tomorrow, so it is
   * only 48 hours long just after midnight — at 23:00, the hour this notice
   * exists for, there are 24 left, and the sentence was promising twice that.
   */
  aheadHours: number;
  /** The bright hour to jump to, already formatted, or null if there is none. */
  brightLabel: string | null;
  onJump: () => void;
  onDismiss: () => void;
};

/**
 * The app opens at the destination's real local time, and the likeliest visitor
 * to a place you go to relax opens it at eleven at night — to an almost unlit
 * frame, with nothing on screen saying the hour can be moved. This says the
 * hour out loud and offers the jump, once, and goes away for good when asked.
 */
export const NightNotice = ({ name, hour, aheadHours, brightLabel, onJump, onDismiss }: NightNoticeProps) => (
  <section className="pointer-events-auto w-full rounded-panel border border-accent/30 bg-panel/80 p-3 text-xs shadow-panel backdrop-blur-md sm:max-w-md">
    <p className="leading-relaxed">
      Ở {name} bây giờ là <span className="font-display text-sm text-accent">{hour}</span>, trời đang tối — bạn đang
      nhìn đúng cảnh thật lúc này.
    </p>
    {/* Not "kéo thanh giờ bên dưới": on a phone the panels start closed, so
        there is no slider below to drag until someone opens one. */}
    {/* A window that has run out would otherwise read "trong 0 tiếng tới". The
        hours already behind are still scrubbable, so what goes is the count. */}
    <p className="mt-1 leading-relaxed text-muted-foreground">
      {aheadHours > 0
        ? `Bạn xem được nơi này vào bất cứ giờ nào trong ${aheadHours} tiếng tới.`
        : 'Bạn xem được nơi này vào bất cứ giờ nào trong dự báo.'}
    </p>

    <div className="mt-2 flex flex-wrap gap-2">
      {brightLabel && (
        <button
          type="button"
          onClick={onJump}
          className="rounded-control border border-accent/60 px-2.5 py-1 text-accent transition-colors hover:border-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3"
        >
          Xem lúc sáng · {brightLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-control border border-border px-2.5 py-1 text-subtle transition-colors hover:border-border-strong [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3"
      >
        Để tối cũng được
      </button>
    </div>
  </section>
);
