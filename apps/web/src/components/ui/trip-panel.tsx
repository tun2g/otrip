'use client';

import { useEffect, useRef, useState } from 'react';

import type { Trip } from '@/hooks/use-trip';
import { cn } from '@/lib/utils';

type TripPanelProps = {
  trip: Trip;
  onStart: (name: string) => void;
  walking: boolean;
  onToggleWalking: () => void;
  view: 'first' | 'third';
  onToggleView: () => void;
  onCopyInvite: () => void;
  inviteLabel: string;
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
}: TripPanelProps) => {
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [leaving, setLeaving] = useState(false);
  const transcriptRef = useRef<HTMLUListElement | null>(null);

  const others = trip.players.length;

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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{companyLabel(others)}</span>
            {trip.roomId && (
              <span className="rounded-control bg-panel-strong/60 px-2 py-0.5 font-mono text-[0.7rem] tracking-wider text-accent">
                {trip.roomId}
              </span>
            )}
          </div>

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
          <p className="mt-1.5 leading-relaxed text-subtle">Ai có link mời cũng vào được phòng này.</p>

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
