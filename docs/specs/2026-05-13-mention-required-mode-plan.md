# Mention-Required Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `MENTION_REQUIRED` mode so the bot stays silent in group chats unless explicitly mentioned, replied to, or addressed by a slash command. DMs are unaffected; default behavior is unchanged.

**Architecture:** One new grammy middleware (`mentionGateMiddleware`) is inserted between the existing auth middleware and the command/message handlers. It reads a new env flag (`MENTION_REQUIRED`) and lets updates through in private chats unconditionally, and in group chats only when a clear engagement signal is present (slash command, @mention, text_mention, reply-to-bot, or callback query). No persisted state, no new commands.

**Tech Stack:** TypeScript, grammy, zod (for env parsing). No new dependencies.

**Spec:** [`docs/specs/2026-05-13-mention-required-mode-design.md`](2026-05-13-mention-required-mode-design.md).

**Repo testing note:** This project has no test framework (`package.json` exposes `dev`, `build`, `typecheck`, `start` only). The plan therefore relies on `npm run typecheck` after each edit plus a final manual smoke test against a real Telegram group. Do not introduce a test framework — that's out of scope.

---

## File map

- **Create:** `src/bot/middleware/mention-gate.middleware.ts` — exports `mentionGateMiddleware(ctx, next)`; pure logic, no I/O beyond `console.log`.
- **Modify:** `src/config.ts` — add `MENTION_REQUIRED` to the zod schema.
- **Modify:** `src/bot/bot.ts` — import the new middleware and register it immediately after `bot.use(authMiddleware)`.
- **Modify:** `.env.example` — document `MENTION_REQUIRED` near the user-allowlist section.
- **Modify:** `docs/index.html` — add a feature card under `data-category="core"`.

No other files should change. There is no test directory.

---

## Task 1: Add the `MENTION_REQUIRED` env flag

**Files:**
- Modify: `src/config.ts` (insert near the other auth-related toggles, after `ALLOWED_GROUP_IDS`)

- [ ] **Step 1: Add the field to the zod schema**

In `src/config.ts`, locate the `ALLOWED_GROUP_IDS` block (around lines 19–22):

```ts
  ALLOWED_GROUP_IDS: z
    .string()
    .default('')
    .transform((val) => val ? val.split(',').map((id) => parseInt(id.trim(), 10)) : []),
```

Insert immediately after it:

```ts
  // When true, in group chats the bot only responds if @-mentioned,
  // replied to, or addressed by a slash command. DMs are unaffected.
  // Default false preserves existing behavior.
  MENTION_REQUIRED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add MENTION_REQUIRED env flag"
```

---

## Task 2: Create the mention-gate middleware

**Files:**
- Create: `src/bot/middleware/mention-gate.middleware.ts`

- [ ] **Step 1: Write the middleware**

Create `src/bot/middleware/mention-gate.middleware.ts` with these exact contents:

```ts
import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

function hasBotMention(
  entities: ReadonlyArray<{ type: string; offset: number; length: number; user?: { id: number } }> | undefined,
  text: string | undefined,
  botUsername: string,
  botId: number,
): boolean {
  if (!entities || entities.length === 0) return false;
  const wanted = '@' + botUsername.toLowerCase();
  for (const ent of entities) {
    if (ent.type === 'bot_command') return true;
    if (ent.type === 'mention' && text) {
      const slice = text.substr(ent.offset, ent.length).toLowerCase();
      if (slice === wanted) return true;
    }
    if (ent.type === 'text_mention' && ent.user?.id === botId) return true;
  }
  return false;
}

export async function mentionGateMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  // Feature off — pass through.
  if (!config.MENTION_REQUIRED) {
    await next();
    return;
  }

  // DMs — never gated.
  if (ctx.chat?.type === 'private') {
    await next();
    return;
  }

  // Callback queries (inline keyboard taps on bot's own messages) — always directed at us.
  if (ctx.callbackQuery) {
    await next();
    return;
  }

  const me = ctx.me;
  if (!me?.username || !me.id) {
    // Fail-open: missing bot identity should never wedge the bot.
    console.warn('[mention-gate] ctx.me missing — passing through');
    await next();
    return;
  }

  const msg = ctx.message;
  if (!msg) {
    // No message and no callback query — nothing to gate. Pass through.
    await next();
    return;
  }

  // Reply to one of the bot's messages counts as engagement.
  if (msg.reply_to_message?.from?.id === me.id) {
    await next();
    return;
  }

  // Mention / bot_command in text or media caption.
  if (hasBotMention(msg.entities, msg.text, me.username, me.id)) {
    await next();
    return;
  }
  if (hasBotMention(msg.caption_entities, msg.caption, me.username, me.id)) {
    await next();
    return;
  }

  console.log(
    `[mention-gate] skipped chat:${ctx.chat?.id ?? 'unknown'} user:${ctx.from?.id ?? 'unknown'}`,
  );
  // Silent drop — do not call next().
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0 with no errors. If grammy's `Context` type rejects the entity shape, the structural type used above (`{ type, offset, length, user? }`) is the inferred subset of `MessageEntity` — no cast needed, but if the compiler complains, replace the `ReadonlyArray<{ ... }>` parameter type with `import('grammy/types').MessageEntity[] | undefined`.

- [ ] **Step 3: Commit**

```bash
git add src/bot/middleware/mention-gate.middleware.ts
git commit -m "feat(bot): add mention-gate middleware"
```

---

## Task 3: Wire the middleware into the bot

**Files:**
- Modify: `src/bot/bot.ts`

- [ ] **Step 1: Import the middleware**

In `src/bot/bot.ts`, find the existing import:

```ts
import { authMiddleware } from './middleware/auth.middleware.js';
```

Add a new line immediately below it:

```ts
import { mentionGateMiddleware } from './middleware/mention-gate.middleware.js';
```

- [ ] **Step 2: Register the middleware after auth**

Locate this existing line (around line 150):

```ts
  // Apply auth middleware to all updates
  bot.use(authMiddleware);
```

Insert immediately after it:

```ts
  // Mention-required gate: in groups, drop messages that aren't addressed to the bot.
  // No-op when MENTION_REQUIRED=false (default) or in private chats.
  bot.use(mentionGateMiddleware);
```

The order is intentional: auth still runs first so unauthorized users get the existing "⛔ not authorized" reply; the gate then filters silently for authorized users in groups who haven't engaged the bot. The gate must also run *before* `bot.command('cancel', ...)` etc. so that `/cancel` correctly passes the gate via its `bot_command` entity — which it does, because the gate is installed before any command handlers.

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 4: Verify the build succeeds**

Run: `npm run build`
Expected: exits 0; `dist/bot/middleware/mention-gate.middleware.js` exists.

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot.ts
git commit -m "feat(bot): wire mention-gate middleware after auth"
```

---

## Task 4: Document the env var in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the env var entry**

Open `.env.example` and locate the `ALLOWED_USER_IDS` line (line 11). Insert these lines immediately after it (keeping the surrounding blank-line structure intact):

```
# Comma-separated Telegram group IDs allowed to use the bot
# Leave empty to disallow groups. Required for anonymous-admin posts in forum topics.
# ALLOWED_GROUP_IDS=

# When true, in group chats the bot only responds when @-mentioned,
# replied to, or addressed by a slash command (e.g. /help or /help@botname).
# Direct messages are unaffected. Default: false (responds to every message).
# MENTION_REQUIRED=false
```

Both `ALLOWED_GROUP_IDS` and `MENTION_REQUIRED` are added here — `ALLOWED_GROUP_IDS` was previously undocumented in `.env.example` but is referenced by `src/bot/middleware/auth.middleware.ts`. Both lines are commented out so default behavior is unchanged for users who copy the file.

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document ALLOWED_GROUP_IDS and MENTION_REQUIRED"
```

---

## Task 5: Add a feature card to the website

**Files:**
- Modify: `docs/index.html`

- [ ] **Step 1: Insert a feature card**

In `docs/index.html`, find the existing "Security Hardened" feature card (around lines 1668–1672):

```html
          <div class="feature-card" data-category="core">
            <div class="feature-icon">🔒</div>
            <h3>Security Hardened</h3>
            <p>SSRF protection blocks private networks, workspace boundaries prevent path traversal, and restrictive file permissions protect your data.</p>
          </div>
```

Insert this new card immediately after that block (and before the existing "Feature Flags" card):

```html
          <div class="feature-card" data-category="core">
            <div class="feature-icon">🤫</div>
            <h3>Mention-Required Mode</h3>
            <p>Optional group-chat mode that keeps the bot silent unless you @-mention it, reply to one of its messages, or send a slash command. DMs are unaffected.</p>
          </div>
```

- [ ] **Step 2: Sanity-check the HTML**

Open `docs/index.html` and confirm the new block is well-formed (`<div>` opens and closes, three children inside, surrounding cards untouched).

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "docs(site): add Mention-Required Mode feature card"
```

---

## Task 6: Manual smoke test

This project has no automated test harness, so verify the change end-to-end against a real bot. Use a development bot token if you have one.

- [ ] **Step 1: Confirm default behavior is unchanged**

In `.env`, leave `MENTION_REQUIRED` unset (or set `MENTION_REQUIRED=false`).
Start the bot: `npm run dev`
In a private chat with the bot, send `hello`.
Expected: the bot responds normally, just like before this change.
In a group chat that's in `ALLOWED_GROUP_IDS` with an allowed user, send `hello`.
Expected: the bot responds normally (unchanged behavior).

- [ ] **Step 2: Enable mention-required mode**

Set `MENTION_REQUIRED=true` in `.env`. Restart: `npm run dev`.

- [ ] **Step 3: DM check**

In a private chat with the bot, send `hello`.
Expected: the bot responds normally (DMs ignore the gate).

- [ ] **Step 4: Plain group message check**

In an allowed group, send `hello` (no mention, no reply).
Expected: the bot is silent; no auth-denied banner. Console shows:
```
[mention-gate] skipped chat:<id> user:<id>
```

- [ ] **Step 5: @mention check**

In the same group, send `@<botname> hello`.
Expected: the bot responds normally.

- [ ] **Step 6: Slash command check**

In the same group, send `/help` (or `/help@<botname>`).
Expected: the help text is sent; no gate skip in logs.

- [ ] **Step 7: Reply-to-bot check**

Reply to any prior bot message with `more please`.
Expected: the bot processes the reply as a normal message.

- [ ] **Step 8: Inline-keyboard check**

Run `/project` (or any command that produces inline buttons) and tap a button.
Expected: the callback is handled normally; no gate skip.

- [ ] **Step 9: Photo/voice caption check (optional but recommended)**

Send a photo with caption `@<botname> describe this`.
Expected: the bot processes the photo.
Send a photo with no caption and no reply-to-bot.
Expected: the bot is silent.

- [ ] **Step 10: Confirm no regressions**

Send a /clear, /status, and /cancel in the group with `MENTION_REQUIRED=true`. All should work.
Restore `.env` to its previous state.

---

## Self-review (writer to do after drafting)

- **Spec coverage:** Config flag ✓ (Task 1), middleware with all 5 engagement rules ✓ (Task 2), wiring ordering ✓ (Task 3), env docs ✓ (Task 4), feature card per CLAUDE.md ✓ (Task 5), acceptance criteria ✓ (Task 6 smoke test).
- **Placeholders:** none.
- **Type consistency:** middleware name `mentionGateMiddleware` is consistent across Task 2 (definition), Task 3 (import + use). Env var name `MENTION_REQUIRED` consistent across Tasks 1, 2, 4.
- **Risk note:** the `Context` typing concern is flagged inline in Task 2 with a fallback (`MessageEntity[]`), so the engineer has a path forward if typecheck complains.
