import { createFileRoute } from "@tanstack/react-router";
import { describeFile } from "@/lib/binary-preview";
import { qwenChat, RE_SYSTEM_PROMPT } from "@/lib/qwen.server";
import {
  deriveTelegramWebhookSecret,
  downloadFile,
  safeEqual,
  sendChatAction,
  sendMessage,
} from "@/lib/telegram.server";

const WELCOME = `CodeCracks — asisten Reverse Engineering (Qwen AI)

Kirim pertanyaan RE apa saja, atau kirim file/kode untuk dianalisa:
- snippet kode, disasm, hex dump, log debugger
- file .txt .c .py .js .asm .bin .exe .elf .dex .apk (maks ~5 MB)

Perintah: /start, /help`;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramMessage = {
  chat?: { id?: number };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
};

async function buildPrompt(message: TelegramMessage): Promise<string | null> {
  const caption = (message.text ?? message.caption ?? "").trim();

  if (message.document) {
    const { file_id, file_name, file_size } = message.document;
    if ((file_size ?? 0) > MAX_FILE_BYTES) {
      return null;
    }
    const { bytes } = await downloadFile(file_id);
    const described = describeFile(file_name ?? "upload.bin", bytes);
    return [
      caption || "Analisa file ini dari sudut pandang reverse engineering.",
      "",
      described,
    ].join("\n");
  }

  if (message.photo?.length) {
    return caption
      ? `${caption}\n\n(Catatan: gambar belum didukung — kirim teks/kode/hex atau file.)`
      : null;
  }

  return caption || null;
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let expectedSecret: string;
        try {
          expectedSecret = deriveTelegramWebhookSecret();
        } catch (error) {
          console.error(error);
          return new Response("Not configured", { status: 500 });
        }

        const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actualSecret, expectedSecret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const update = (await request.json()) as TelegramUpdate;
        const message = update.message ?? update.edited_message;
        const chatId = message?.chat?.id;
        if (!message || typeof chatId !== "number") {
          return Response.json({ ok: true, ignored: true });
        }

        const command = (message.text ?? "").trim().toLowerCase();
        if (command === "/start" || command === "/help") {
          await sendMessage(chatId, WELCOME);
          return Response.json({ ok: true });
        }

        try {
          await sendChatAction(chatId);
          const prompt = await buildPrompt(message);
          if (!prompt) {
            await sendMessage(
              chatId,
              "Kirim teks, kode, hex dump, atau file (maks 5 MB) yang mau dianalisa.",
            );
            return Response.json({ ok: true });
          }

          const answer = await qwenChat([
            { role: "system", content: RE_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ]);
          await sendMessage(chatId, answer);
        } catch (error) {
          console.error("CodeCracks webhook error", error);
          const detail = error instanceof Error ? error.message : String(error);
          try {
            await sendMessage(chatId, `Gagal memproses permintaan.\n\n${detail.slice(0, 500)}`);
          } catch (sendError) {
            console.error("Failed to notify chat", sendError);
          }
        }

        return Response.json({ ok: true });
      },
    },
  },
});
