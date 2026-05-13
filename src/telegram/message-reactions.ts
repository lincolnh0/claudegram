import { Context } from 'grammy';

type ReactionEmoji = '👀' | '👌' | '💔';

async function setReaction(ctx: Context, emoji: ReactionEmoji): Promise<void> {
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
  await setReaction(ctx, '👀');
}

export async function markSuccess(ctx: Context): Promise<void> {
  await setReaction(ctx, '👌');
}

export async function markError(ctx: Context): Promise<void> {
  await setReaction(ctx, '💔');
}
