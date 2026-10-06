/**
 * The room in the page's own URL.
 *
 * Split from `trip-client.ts` because it is the one part of the transport with
 * no transport in it — no SDK, no socket, nothing to await — and because the key
 * and what counts as an id have to be one definition shared by the address bar,
 * the invite link and `joinById`. `trip-client` re-exports all of it, so there
 * is still one place to import from.
 *
 * Before this the id only ever reached the *copied* invite link, so the host's
 * own address bar never had it: a reload lost the room, and there was nothing to
 * share but a button.
 */

/** Short on purpose. The address bar already carries `?luc=` and this sits next
 *  to it in something a person pastes into a chat. */
export const ROOM_PARAM = 'r';

/**
 * What a room id can be.
 *
 * Colyseus ids are `nanoid(9)` over its url alphabet, which is letters, digits,
 * `-` and `_`. The range is wider than nine so that a server configured
 * otherwise still works, and it is bounded at all because this value arrives
 * from the address bar and goes into `client.joinById`.
 */
const ROOM_ID = /^[A-Za-z0-9_-]{4,32}$/;

export const isRoomId = (value: unknown): value is string => typeof value === 'string' && ROOM_ID.test(value);

/** The query of a full URL, of a `?a=b` search, or of a bare `a=b`. Anything
 *  past a fragment is not the query and is dropped with it. */
const queryOf = (from: string): URLSearchParams => {
  const hash = from.indexOf('#');
  const whole = hash >= 0 ? from.slice(0, hash) : from;
  const mark = whole.indexOf('?');
  return new URLSearchParams(mark >= 0 ? whole.slice(mark + 1) : whole);
};

/**
 * The room id in a URL, or null.
 *
 * Null for anything that is not an id — empty, five hundred characters, `../`,
 * a URL of its own — rather than a throw, because every one of those arrives
 * from somebody's address bar and the page still has to render.
 *
 * There is deliberately no `?phong=` fallback. Rooms are held in RAM and die
 * with the server, so every link ever built with the old key is already a link
 * to a room that does not exist; carrying it would be compatibility with
 * nothing.
 */
export const readRoomId = (from?: string): string | null => {
  const source = from ?? (typeof window === 'undefined' ? '' : window.location.search);
  if (!source) return null;
  const found = queryOf(source).get(ROOM_PARAM);
  return isRoomId(found) ? found : null;
};

/**
 * The link a friend is sent. Built from the page's own URL, so whatever hour is
 * pinned in `?luc=` goes with the invitation.
 *
 * The fallback is only reached when there is no `window`, where there is also no
 * room to invite anybody to; it is the same pair `layout.tsx` gives
 * `metadataBase` so that there is one answer in the app to "where does this
 * site live", and not two that disagree.
 */
export const inviteUrl = (roomId: string, from?: string): string => {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const base = from ?? (typeof window === 'undefined' ? site : window.location.href);
  const url = new URL(base);
  url.searchParams.set(ROOM_PARAM, roomId);
  return url.toString();
};

/**
 * Puts the room in the address bar, or takes it out.
 *
 * Both this and `location-scene.tsx`'s hour writer call `replaceState` on the
 * same URL, and the way one of two such callers loses is by building its URL
 * from a snapshot taken earlier. Neither does: each reads `window.location.href`
 * at the moment it writes and touches one key. So there is no ordering to
 * arbitrate — last write wins and both keys survive it, whichever order they
 * come in.
 */
export const showRoomId = (roomId: string | null) => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (roomId && isRoomId(roomId)) url.searchParams.set(ROOM_PARAM, roomId);
  else url.searchParams.delete(ROOM_PARAM);
  window.history.replaceState(null, '', url);
};
