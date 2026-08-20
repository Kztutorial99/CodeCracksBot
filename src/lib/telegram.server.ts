import { createHash, timingSafeEqual } from "crypto";
import {
  markdownToPlainText,
  markdownToTelegramHtmlChunks,
} from "@/lib/markdown-telegram";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// Direct Telegram Bot API (used when TELEGRAM_BOT_TOKEN is set, e.g. on Vercel).
// Falls back to the Lovable connector gateway otherwise.
function botToken(): string | undefined {
  return process.env["TELEGRAM_BOT_TOKEN"];
}

function gatewayHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv("LOVABLE_API_KEY")}`,
    "X-Connection-Api-Key": requireEnv("TELEGRAM_API_KEY"),
  };
}

export function deriveTelegramWebhookSecret(): string {
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];
  if (secret) return secret;
  return createHash("sha256")
    .update(`telegram-webhook:${botToken() ?? requireEnv("TELEGRAM_API_KEY")}`)
    .digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function callTelegram(method: string, body: unknown) {
  const token = botToken();
  const url = token
    ? `https://api.telegram.org/bot${token}/${method}`
    : `${GATEWAY_URL}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: token
      ? { "Content-Type": "application/json" }
      : { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`Telegram ${method} failed [${response.status}]: ${text}`);
    throw new Error(`Telegram ${method} failed [${response.status}]: ${text}`);
  }
  const data = JSON.parse(text) as { ok: boolean; error_code?: number; description?: string; result?: unknown };
  if (!data.ok) {
    console.error(`Telegram ${method} returned not ok: ${text}`);
    throw new Error(`Telegram ${method} error: ${data.description ?? text}`);
  }
  return data.result;
}

const MAX_LEN = 3500;

async function sendChunk(chatId: number, html: string, plain: string) {
  try {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error("HTML send failed, falling back to plain text", error);
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: plain,
      disable_web_page_preview: true,
    });
  }
}

/**
 * Sends markdown from the model as Telegram HTML so fenced code blocks are
 * rendered as highlighted `pre`/`code` entities (with language) in clients.
 */
export async function sendMessage(chatId: number, text: string) {
  const chunks = markdownToTelegramHtmlChunks(text, MAX_LEN);
  const plainFallback = markdownToPlainText(text);
  for (const chunk of chunks) {
    await sendChunk(chatId, chunk, plainFallback.slice(0, MAX_LEN));
  }
}

export async function sendChatAction(chatId: number) {
  try {
    await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    // typing indicator is best-effort
  }
}

export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const result = (await callTelegram("getFile", { file_id: fileId })) as { file_path: string };
  const token = botToken();
  const response = token
    ? await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`)
    : await fetch(`${GATEWAY_URL}/file/${result.file_path}`, { headers: gatewayHeaders() });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Telegram file download failed [${response.status}]: ${body}`);
    throw new Error(`Telegram file download failed [${response.status}]`);
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), path: result.file_path };
}

/** Lightweight progress message the bot edits while it works. */
export async function sendStatus(chatId: number, text: string): Promise<number | null> {
  try {
    const result = (await callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    })) as { message_id?: number } | undefined;
    return result?.message_id ?? null;
  } catch {
    return null;
  }
}

export async function editStatus(chatId: number, messageId: number | null, text: string) {
  if (messageId == null) return;
  try {
    await callTelegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    });
  } catch {
    // progress updates are best-effort (ignores "message is not modified")
  }
}

export async function deleteStatus(chatId: number, messageId: number | null) {
  if (messageId == null) return;
  try {
    await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // best-effort
  }
}

/** Pins the progress message so the running status stays visible at the top. */
export async function pinMessage(chatId: number, messageId: number | null) {
  if (messageId == null) return;
  try {
    await callTelegram("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  } catch {
    // pinning needs admin rights in groups; best-effort
  }
}

export async function unpinMessage(chatId: number, messageId: number | null) {
  if (messageId == null) return;
  try {
    await callTelegram("unpinChatMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // best-effort
  }
}

type InlineButton = { text: string; callback_data: string };

export async function sendMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineButton[][],
) {
  await callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function editMessageWithKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineButton[][],
) {
  try {
    await callTelegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch {
    // best-effort (ignores "message is not modified")
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch {
    // best-effort
  }
}
