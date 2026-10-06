'use client';

import { useEffect, useRef, useState } from 'react';

import { companionDistance, directionWords, type Viewpoint } from '@/components/ui/companion-compass';
import type { Trip } from '@/hooks/use-trip';
import { cn } from '@/lib/utils';
import { colourFor, relativeTo } from '@/scene/companion-markers';

type TripPanelProps = {
  trip: Trip;
  onStart: (name: string) => void;
  walking: boolean;
  onToggleWalking: () => void;
  view: 'first' | 'third';
  onToggleView: () => void;
  onCopyInvite: () => void;
  inviteLabel: string;
  /**
   * Where the camera is and which way it looks, or null while browsing. Read at
   * render time rather than polled: `trip-client.ts` rebuilds the roster on every
   * state change and the server echoes your own position back, so this panel
   * already re-renders ten times a second whenever anybody in the room moves —
   * including you. When nothing moves there is nothing to go stale.
   */
  viewpoint?: () => Viewpoint | null;
};

const CHIP =
  'rounded-control border border-border px-2.5 py-1 transition-colors hover:border-accent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3';

/**
 * "1 người" never said whether that one was you. On an app whose whole promise
 * is going somewhere together, this is the number that matters most.
 */
const companyLabel = (others: number): string => (others === 0 ? 'Chỉ có bạn' : `Bạn và ${others} người nữa`);

export const TripPanel = ({
  trip,
  onStart,
  walking,
  onToggleWalking,
  view,
  onToggleView,
  onCopyInvite,
  inviteLabel,
  viewpoint,
}: TripPanelProps) => {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [leaving, setLeaving] = useState(false);
  const transcriptRef = useRef<HTMLUListElement | null>(null);

  const others = trip.players.length;
  // "Bạn và 1 người nữa" was the whole of what this panel said about the people
  // it was counting, which is a number with nothing behind it: the one reader who
  // could not see their companion was told they had one and given no way to ask
  // where. On foot each name opens into a distance and a direction; from the
  // sightseeing camera there is no "you" to measure from, so it stays a roster
  // and says what to do about it.
  const here = walking ? (viewpoint?.() ?? null) : null;

  // A transcript that keeps the first message on screen is a transcript nobody
  // reads: the newest line is the one being talked about.
  useEffect(() => {
    const list = transcriptRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [trip.chat.length]);

  useEffect(() => {
    if (trip.status !== 'joined') setLeaving(false);
  }, [trip.status]);

  return (
    <section className="pointer-events-auto w-full rounded-panel bg-panel/70 p-3 text-xs shadow-panel backdrop-blur-md sm:max-w-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onToggleWalking} className={cn(CHIP, walking && 'border-accent text-accent')}>
          {walking ? 'Về ngắm cảnh' : 'Đi bộ'}
        </button>

        {walking && (
          <button type="button" onClick={onToggleView} title="Phím V" className={CHIP}>
            {view === 'first' ? 'Ngôi thứ nhất' : 'Ngôi thứ ba'} · V
          </button>
        )}
      </div>

      {trip.status !== 'joined' && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onStart(name.trim() || 'Khách');
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tên bạn"
            maxLength={24}
            aria-label="Tên hiển thị trong chuyến đi"
            className="min-w-0 flex-1 rounded-control border border-border bg-panel-strong/60 px-2 py-1 outline-none focus:border-accent [@media(pointer:coarse)]:min-h-11"
          />
          <button type="submit" disabled={trip.status === 'connecting'} className={cn(CHIP, 'disabled:text-subtle')}>
            {trip.status === 'connecting' ? 'Đang vào…' : 'Rủ bạn đi cùng'}
          </button>
        </form>
      )}

      {trip.error && <p className="mt-2 leading-relaxed text-subtle">{trip.error}</p>}

      {trip.status === 'joined' && (
        <>
          <p className="mt-2 text-muted-foreground">{companyLabel(others)}</p>

          {others > 0 && (
            <ul className="mt-1.5 space-y-1">
              {trip.players.map((person) => {
                const placed = here && Number.isFinite(person.x) && Number.isFinite(person.z);
                const bearing = placed ? relativeTo(here, person) : null;

                return (
                  <li key={person.id} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: colourFor(person.id) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{person.name}</span>
                    {bearing && (
                      <span className="shrink-0 text-subtle">
                        {companionDistance(bearing.range)} · {directionWords(bearing.bearing)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {others > 0 && !walking && (
            <p className="mt-1.5 leading-relaxed text-subtle">
              Từ trên cao mỗi người chỉ là một vòng tròn nhỏ trên sườn núi. Bấm “Đi bộ” để lại đứng cạnh nhau.
            </p>
          )}

          {trip.roomId && (
            <p className="mt-2 text-subtle">
              Mã phòng{' '}
              <span className="rounded-control bg-panel-strong/60 px-1.5 py-0.5 font-mono tracking-wider text-accent">
                {trip.roomId}
              </span>
            </p>
          )}

          {/* The full invite URL used to be printed here. A room link is a key:
              anyone reading the screen, or a screenshot of it, was in. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={onCopyInvite} className={cn(CHIP, 'border-accent/60 text-accent')}>
              {inviteLabel}
            </button>
            {!leaving && (
              <button type="button" onClick={() => setLeaving(true)} className={cn(CHIP, 'text-subtle')}>
                Rời
              </button>
            )}
          </div>
          {/* The second sentence is the reported bug, written down. Two windows
              that each pressed "Rủ bạn đi cùng" create two rooms, both correctly
              reading "Chỉ có bạn", and the code above is the only thing on screen
              that tells them apart. */}
          <p className="mt-1.5 leading-relaxed text-subtle">
            Ai có link mời cũng vào được phòng này. Hai người phải cùng một mã phòng mới thấy nhau.
          </p>

          {leaving && (
            <div className="mt-2 rounded-control border border-accent/40 bg-panel-strong/60 p-2.5">
              <p className="leading-relaxed text-muted-foreground">
                {others === 0
                  ? 'Rời bây giờ thì phòng này đóng lại và link mời cũ không còn ai ở trong.'
                  : `Rời bây giờ thì bạn không còn thấy ${others} người kia, và họ không còn thấy bạn.`}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={trip.leave}
                  className={cn(CHIP, 'border-accent-strong/70 text-accent-strong')}
                >
                  Rời chuyến đi
                </button>
                <button type="button" onClick={() => setLeaving(false)} className={CHIP}>
                  Ở lại
                </button>
              </div>
            </div>
          )}

          <p className="mt-3 text-[0.65rem] tracking-wide text-subtle uppercase">Tin nhắn nhóm</p>
          <ul
            ref={transcriptRef}
            aria-live="polite"
            className="mt-1 max-h-32 space-y-1 overflow-y-auto overscroll-contain"
          >
            {trip.chat.length === 0 ? (
              <li className="text-subtle">Chưa có tin nhắn nào. Gõ một câu, cả nhóm thấy ngay.</li>
            ) : (
              trip.chat.map((line, position) => (
                <li key={`${line.at}-${position}`} className="leading-relaxed text-muted-foreground">
                  <span className="text-accent">{line.from}</span> {line.text}
                </li>
              ))
            )}
          </ul>

          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              trip.say(draft.trim());
              setDraft('');
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Nhắn cho cả nhóm"
              maxLength={200}
              aria-label="Tin nhắn nhóm"
              className="min-w-0 flex-1 rounded-control border border-border bg-panel-strong/60 px-2 py-1 outline-none focus:border-accent [@media(pointer:coarse)]:min-h-11"
            />
            <button type="submit" className={CHIP}>
              Gửi
            </button>
          </form>
        </>
      )}
    </section>
  );
};
