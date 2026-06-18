# TASK: Banter Box chat UI + wiring

> Build the live "Banter Box" column from the Goal Rush redesign and wire it to
> the real chat backend: messages, reactions, preset chips, send box, typing/
> online indicators. Depends on TASK-goalrush-ui-port and TASK-chat-backend.

## Context

`TASK-goalrush-ui-port.md` lands the predict + result columns and leaves a sized
slot for chat. `TASK-chat-backend.md` provides the Neon-backed endpoints. This
task fills the slot with the real Banter Box, replacing every faked piece in the
prototype (local bots, hardcoded counts, in-memory reactions) with calls to the
backend. **Drop the bot replies entirely** — they were mock flavor and there is
no bot service.

## Requirements

1. **Message list + send.** Render messages from `GET /chat/{ref}` (own messages
   right-aligned, others left, system messages centered), with the avatar/name/
   time treatment from the prototype. The send box and Enter key `POST
   /chat/{ref}`; on success the new message appears via the next poll.
2. **Polling loop.** Poll `GET /chat/{ref}?since={lastId}` every ~2s while the
   tab is visible (pause when hidden), advancing the `since` cursor; auto-scroll
   to bottom on new messages, matching the prototype's scroll behavior.
3. **Reactions.** The emoji picker and existing-reaction pills call `POST
   /chat/{ref}/react`; counts and the "you reacted" highlight come from the
   read endpoint, not local state.
4. **Presence + presets.** Send a presence `ping` on load and on an interval;
   show the live online count from the backend (no hardcoded "6 online"). Preset
   "banter" chips send real messages via the same POST path.
5. **Identity + read-only fallback.** Posting uses the server cookie identity;
   when there's no verified session (dev stub / no token), render the chat
   read-only with a clear "sign in via Rooms to chat" affordance rather than a
   broken send box.

## Implementation Notes

- **Files:** `src/app/RoomClient.tsx` (or a new `src/app/BanterBox.tsx` it
  mounts) + `globals.css`. No new dependencies.
- **Lock-in system message:** when the player locks their pick, post a system
  message (e.g. "⭐ You locked in …") through the chat backend so everyone sees
  it — replacing the prototype's local-only system bubble. Coordinate the call
  with the existing lock/submit handler from the UI-port task.
- **Cursor + dedupe:** track the highest message `id` seen; never re-render
  duplicates if a poll overlaps an optimistic insert. Prefer server truth — if
  you show an optimistic message, reconcile it by `id` on the next poll.
- **Visibility:** use `document.visibilitychange` to pause polling/heartbeat in
  background tabs to avoid hammering Neon.
- **Reaction emoji set / presets:** carry over the prototype's emoji set and
  preset strings as UI constants; they're presentation only.

## Do Not Change

- All `/chat/*` route handlers, `src/lib/db.ts`, `src/lib/chatSession.ts`,
  `middleware.ts` — delivered and owned by `TASK-chat-backend.md`; consume them,
  don't edit them.
- `src/lib/rooms.ts`, `roomsAuth.ts`, and the pick/score/phase/resolve routes.
- The predict + result columns from `TASK-goalrush-ui-port.md` beyond mounting
  the chat slot and wiring the lock-in system message.

## Acceptance Criteria

- [ ] `npm run build` passes with zero errors.
- [ ] Two browser sessions in the same ref see each other's messages within ~2s.
- [ ] Reactions and online count reflect the backend across both sessions; no
      hardcoded counts and no bot messages anywhere in the diff.
- [ ] Locking a pick posts a system message visible to both sessions.
- [ ] With `?name=Dev` (no token), chat is read-only with a clear sign-in prompt;
      the send box does not silently fail.
- [ ] Polling pauses in a hidden tab.

## Verification

1. `npm run build`; open two tabs on `/?ref=match-38` (one with a valid token,
   one with `?name=Dev`) and confirm cross-tab messages, reactions, presence.
2. `git grep -nE "botLines|scheduleBot|6 online|online = \["` returns nothing.
3. Confirm no edits to backend chat files via `git diff --stat`.
