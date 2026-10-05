'use client';

import type { AudioState } from '@/hooks/use-audio';

const TRACK_LABELS: Record<string, string> = {
  dreamscape: 'DreamScape · HoliznaCC0',
  rain: 'Rain / Sleep · HoliznaCC0',
};

export const AudioControls = ({ audio }: { audio: AudioState }) => {
  if (!audio.started) {
    return (
      <button
        type="button"
        onClick={audio.start}
        disabled={audio.loading}
        className="pointer-events-auto rounded-control bg-panel/70 px-3 py-2 text-xs shadow-panel backdrop-blur-md transition-colors hover:text-accent disabled:text-subtle"
      >
        {audio.loading ? '♪ đang tải tiếng…' : '♪ Chạm để nghe gió'}
      </button>
    );
  }

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-control bg-panel/70 px-3 py-2 text-xs shadow-panel backdrop-blur-md">
      <span className="max-w-[12rem] truncate text-muted-foreground">
        {audio.track ? (TRACK_LABELS[audio.track] ?? audio.track) : 'Tiếng môi trường'}
      </span>
      <button type="button" onClick={audio.next} className="text-accent transition-opacity hover:opacity-80">
        Bài sau
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(audio.volume * 100)}
        onChange={(event) => audio.setVolume(Number(event.target.value) / 100)}
        aria-label="Âm lượng"
        className="w-20 accent-accent"
      />
      {audio.error && <span className="text-subtle">{audio.error}</span>}
    </div>
  );
};
