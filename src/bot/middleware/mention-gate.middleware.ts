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
      const slice = text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
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
