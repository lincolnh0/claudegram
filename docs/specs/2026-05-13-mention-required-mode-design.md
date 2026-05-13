# Mention-Required Mode — Design

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan

## Goal

Add an opt-in mode that makes the bot ignore group-chat messages unless it is explicitly engaged (mentioned or replied to). Direct messages are unaffected. The mode is off by default; existing deployments see no behavior change.

## Motivation

In shared Telegram groups the bot currently responds to every message from an allowed user. Users who keep the bot in groups for occasional commands want it to stay quiet unless addressed directly.

## Configuration

Add one env var in `src/config.ts`, alongside the existing toggles:

```ts
MENTION_REQUIRED: z.string().default('false').transform(toBool)
```

- **Default:** `false` (current behavior preserved).
- **Type:** boolean string (`true` / `false`), matching the project's existing pattern (`TTS_ENABLED`, `REDDIT_ENABLED`, etc.).
- **Scope:** global — applies to every group the bot is in.

Per-group overrides are explicitly out of scope.

## Engagement rules

When `MENTION_REQUIRED=true`, in a non-private chat the update passes through only if at least one of these is true:

1. The update is a callback query (button on the bot's own keyboard — inherently directed at the bot).
2. `message.entities` (or `message.caption_entities`) contains a `bot_command` entity. Telegram already routes `/cmd@OtherBot` to other bots, so any `bot_command` we receive is implicitly for us.
3. `message.entities` (or `message.caption_entities`) contains a `mention` entity whose text matches `@<botUsername>` (case-insensitive).
4. `message.entities` (or `message.caption_entities`) contains a `text_mention` entity whose `user.id` equals the bot's id.
5. `message.reply_to_message.from.id` equals the bot's id (reply to one of our messages — covers ForceReply flows like transcribe and project picker).

Otherwise the update is dropped silently — no reply is sent to the group. One concise log line is emitted for observability:

```
[mention-gate] skipped chat:<id> user:<id>
```

In **private chats** (`ctx.chat.type === 'private'`) the gate always passes through, regardless of `MENTION_REQUIRED`.

## Architecture

### New middleware

`src/bot/middleware/mention-gate.middleware.ts` — a grammy middleware exporting `mentionGateMiddleware(ctx, next)`.

It reads:
- `config.MENTION_REQUIRED` — feature flag.
- `ctx.chat.type` — to skip DMs.
- `ctx.me` — grammy's per-request snapshot of `bot.botInfo` (username + id), populated after `bot.init()`.

It does not depend on or modify any persisted state.

### Wiring

In `src/bot/bot.ts`, register the new middleware **immediately after** `bot.use(authMiddleware)` and **before** any handler registration. The ordering matters:

- Auth runs first so unauthorized users still get the existing "⛔ not authorized" reply.
- The mention gate then filters silently for *authorized* users in groups who haven't engaged the bot.

The existing `/cancel` handler is registered before `sequentialize`. The mention gate does not affect that path; bot_command entities pass the gate.

### What the gate does NOT do

- It does not send replies (silent drop).
- It does not change auth or rate-limiting behavior.
- It does not introduce persisted state.
- It does not add new commands.

## Coverage matrix

| Update kind                     | Gate behavior in groups                          |
|---------------------------------|--------------------------------------------------|
| Text message                    | Check `entities` for mention / bot_command       |
| Photo / document / voice        | Check `caption_entities` for mention             |
| Reply to bot message            | Pass (engagement signal)                         |
| Slash command (`/foo` or `/foo@bot`) | Pass (bot_command entity)                   |
| Inline-keyboard callback        | Pass (callback query — always directed)          |
| Edited messages                 | Already not handled by the bot — no change       |
| Private chats                   | Pass (gate disabled)                             |

## Documentation requirements

Per `CLAUDE.md`:

1. **`docs/index.html`** — add a feature card describing mention-required mode. Use `data-category="core"`.
2. **README / env-var documentation** — if there is an env-var table or `.env.example`, add `MENTION_REQUIRED` with default `false` and a brief description. (Verify during implementation; do not create new docs files.)

## Out of scope (YAGNI)

- Per-group toggle (`/mention` command + persisted state).
- "Tag me to talk" reply when ignoring a message.
- A whitelist of always-active words/commands beyond Telegram's bot_command entity.
- Mention-required mode for DMs.
- Telemetry/metrics on how often the gate drops messages.

## Risks and mitigations

- **Bot username case sensitivity.** Telegram usernames are case-insensitive. The check must compare lowercased strings to avoid missing valid mentions.
- **`ctx.me` availability.** grammy populates `ctx.me` once `bot.init()` is called (which the launcher already does). If for any reason `ctx.me` is missing, the gate should fail-open (let the update through) rather than wedging the bot — but log a warning.
- **Forum topic groups.** `ctx.chat.type` is `supergroup` for forum chats; the gate treats them as groups, which is correct. Reply-to-bot still works inside topics.

## Acceptance criteria

- With `MENTION_REQUIRED=false` (or unset), behavior is identical to today.
- With `MENTION_REQUIRED=true` in a group:
  - A plain message ("hello") gets no reply and no auth-denied banner.
  - `/help` (or `/help@botname`) is processed normally.
  - `@<botname> hello` is processed normally.
  - A reply to any prior bot message is processed normally.
  - Pressing an inline keyboard button on a bot message works normally.
- In a private chat, `MENTION_REQUIRED=true` has no observable effect.
- A new feature card appears in `docs/index.html`.
