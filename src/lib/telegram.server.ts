import { createHash, timingSafeEqual } from "crypto";

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

const MAX_LEN = 3800;

export async function sendMessage(chatId: number, text: string) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);

  for (const chunk of chunks) {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
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
