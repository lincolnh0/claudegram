# Message Reactions — Design

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan

## Goal

When the bot accepts a free-form text message and starts routing it to the Claude agent, it places a 👀 reaction on the user's message. When processing finishes the reaction is replaced — ✅ on success, ❌ on error or cancellation. This gives users immediate, lightweight feedback that their message was received and is being worked on, without any extra reply messages.

## Scope

**Reacted to:**
- Free-form text messages that reach `sendToAgent` (default flow) — handled in `handleMessage` in `src/bot/handlers/message.handler.ts`.
- ForceReply replies that route to the agent: `plan`, `explore`, `loop` modes — handled in `handleAgentReply` in the same file.

**NOT reacted to:**
- Slash commands (`/clear`, `/status`, `/help`, `/cancel`, …) — complete near-instantly; reaction adds noise.
- Voice messages and photo messages.
- Built-in tool commands and their auto-detected URL flows (`/extract`, `/reddit`, `/vreddit`, `/medium`, `/transcribe`, the YouTube/TikTok/Instagram auto-menu, `vreddit` URL auto-handler).
- ForceReply replies that do *not* go to the agent (`handleProjectReply`, `handleTelegraphReply`, `handleFileReply`).
- Messages dropped by auth or the mention-required gate (they never reach `handleMessage`).
- Messages early-returned for staleness, duplicate detection, queue-clear, or "no project set" warnings.

## Lifecycle states

| State                                 | Reaction |
|---------------------------------------|----------|
| Accepted, processing started or queued | 👀       |
| Agent returned a response              | ✅       |
| Agent threw an error                   | ❌       |
| `/cancel` or `/softreset` interrupted  | ❌       |

The 👀 → ✅/❌ transition is a single `setMessageReaction` call (Telegram's API replaces all existing reactions from a given bot account).

## Module

Create `src/telegram/message-reactions.ts`:

```ts
import { Context } from 'grammy';

const PROCESSING = '👀';
const SUCCESS = '✅';
const ERROR = '❌';

async function setReaction(ctx: Context, emoji: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !messageId) return;
  try {
    await ctx.api.setMessageReaction(chatId, messageId, [
      { type: 'emoji', emoji },
    ]);
  } catch (err) {
    console.warn(
      `[reactions] failed to set ${emoji} on chat:${chatId} msg:${messageId} — ${(err as Error).message}`,
    );
  }
}

export async function markProcessing(ctx: Context): Promise<void> {
  await setReaction(ctx, PROCESSING);
}

export async function markSuccess(ctx: Context): Promise<void> {
  await setReaction(ctx, SUCCESS);
}

export async function markError(ctx: Context): Promise<void> {
  await setReaction(ctx, ERROR);
}
```

**Properties:**
- All three exported functions are safe to call from any handler. They short-circuit when chat or message id is unavailable (e.g., channel posts, edits).
- Failures are swallowed with a single `console.warn`. Reactions never throw or block real work.
- No new dependencies. grammy's `Context.api.setMessageReaction` is already available (grammy ^1.31 supports the Bot API method).

## Wiring

### `handleMessage` (main free-form path)

In `src/bot/handlers/message.handler.ts`, the relevant block is currently:

```ts
try {
  await queueRequest(sessionKey, text, async () => {
    if (getStreamingMode() === 'streaming') {
      await handleStreamingResponse(ctx, sessionKey, text);
    } else {
      await handleWaitResponse(ctx, sessionKey, chatId, text);
    }
  });
} catch (error) {
  if ((error as Error).message === 'Queue cleared') {
    return;
  }
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Error handling message:', error);
  await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
}
```

Change to:

```ts
await markProcessing(ctx);
try {
  await queueRequest(sessionKey, text, async () => {
    if (getStreamingMode() === 'streaming') {
      await handleStreamingResponse(ctx, sessionKey, text);
    } else {
      await handleWaitResponse(ctx, sessionKey, chatId, text);
    }
  });
  await markSuccess(ctx);
} catch (error) {
  await markError(ctx);
  if ((error as Error).message === 'Queue cleared') {
    return;
  }
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Error handling message:', error);
  await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
}
```

### `handleAgentReply` (plan/explore/loop)

The same shape — `await markProcessing(ctx)` right before the existing `try { await queueRequest(...) }`, `await markSuccess(ctx)` after the queueRequest call resolves inside the try, and `await markError(ctx)` at the top of the catch (before the `Queue cleared` early-return).

### Nothing else changes

The request-queue, abort controller, streaming sender, and command handlers stay untouched. The change is localized to the two free-form-text entry points.

## Failure handling

- The Telegram API rejects `setMessageReaction` if the bot lacks reaction permissions in a group/channel, if the message has been deleted, or for certain anonymous/channel posts. All failures funnel through the single `try/catch` inside `setReaction`, which logs a warning and returns. The user-facing flow continues normally.
- Reactions are limited per chat by Telegram (premium emojis aren't available to bots; the three emojis here — 👀 ✅ ❌ — are part of the standard free reaction set, so they will be available in any chat where the bot can react at all).
- The `Queue cleared` branch (raised when `/cancel` clears a queued message) currently silently returns. With this change it still returns, but only *after* the ❌ reaction is set — so the user sees their cancelled message marked ❌, matching the design.

## Out of scope (YAGNI)

- Config flag to disable reactions. Reactions are non-intrusive; if a deployment doesn't want them, this can be added later. Not added now.
- Per-chat or per-user preferences.
- Reactions on slash commands, voice, photo, or tool flows.
- Streaming "in-progress" updates beyond the single 👀.
- Removing the 👀 entirely on cancel (the user confirmed ❌ for both errors and cancel).
- A queue indicator emoji (e.g., ⏳) — the existing "Queued (position N)" reply already conveys this.

## Acceptance criteria

- Sending free-form text to the bot in DM produces a 👀 on the message almost immediately, replaced by ✅ when the bot's response is sent.
- An agent error replaces 👀 with ❌.
- `/cancel` while a query is running replaces 👀 with ❌ on the originating message.
- Slash commands, voice notes, photos, `/extract`, `/reddit`, `/vreddit`, `/medium`, `/transcribe`, YouTube/TikTok/Instagram auto-menu, and ForceReply replies for project/file/telegraph picking get **no** reaction.
- If the bot lacks reaction permissions in a group, processing still works — a single `[reactions] failed …` warning is logged and no further side effects.

## Risks

- **Telegram premium-only emojis.** None of 👀, ✅, ❌ are premium-only; all are in the free-reaction set. Confirmed against Bot API documentation.
- **Reaction visibility in topic groups.** Reactions work on messages inside forum topics — no special handling required.
- **High-frequency messages.** The added `setMessageReaction` call is one API request per accepted message at start, one at end. No new rate-limit concerns at the bot's existing scale.
