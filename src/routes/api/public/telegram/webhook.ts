import { createFileRoute } from "@tanstack/react-router";
import { describeFile } from "@/lib/binary-preview";
import { qwenChat, RE_SYSTEM_PROMPT, type QwenMessage } from "@/lib/qwen.server";
import {
  deriveTelegramWebhookSecret,
  downloadFile,
  safeEqual,
  sendChatAction,
  sendMessage,
} from "@/lib/telegram.server";

const WELCOME = `CodeCracks — asisten Reverse Engineering (Qwen AI)

Model dipilih otomatis, kamu tidak perlu memilih:
- teks kualitas terbaik: qwen3.8-max
- coding / analisa kode & binary: qwen3-coder-plus
- gambar / screenshot: qwen3-vl-flash

Kirim pertanyaan RE apa saja, atau kirim file/gambar/kode untuk dianalisa:
- snippet kode, disasm, hex dump, log debugger
- screenshot IDA/Ghidra/x64dbg atau UI aplikasi
- file .txt .c .py .js .asm .bin .exe .elf .dex .apk (maks ~5 MB)

Perintah: /start, /help`;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramMessage = {
  chat?: { id?: number };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
  photo?: { file_id: string; file_size?: number }[];
};

function toDataUrl(bytes: Uint8Array, path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
  const mime =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Builds the user message; images become vision content so the router picks qwen3-vl-flash. */
async function buildUserMessage(message: TelegramMessage): Promise<QwenMessage | null> {
  const caption = (message.text ?? message.caption ?? "").trim();

  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
  const imageDocument =
    message.document && (message.document.mime_type ?? "").startsWith("image/")
      ? message.document
      : undefined;
  const imageFile = photo ?? imageDocument;

  if (imageFile) {
    if ((imageFile.file_size ?? 0) > MAX_IMAGE_BYTES) return null;
    const { bytes, path } = await downloadFile(imageFile.file_id);
    return {
      role: "user",
      content: [
        {
          type: "text",
          text:
            caption ||
            "Baca isi gambar ini lalu analisa dari sudut pandang reverse engineering.",
        },
        { type: "image_url", image_url: { url: toDataUrl(bytes, path) } },
      ],
    };
  }

  if (message.document) {
    const { file_id, file_name, file_size } = message.document;
    if ((file_size ?? 0) > MAX_FILE_BYTES) return null;
    const { bytes } = await downloadFile(file_id);
    const described = describeFile(file_name ?? "upload.bin", bytes);
    return {
      role: "user",
      content: [
        caption || "Analisa file ini dari sudut pandang reverse engineering.",
        "",
        described,
      ].join("\n"),
    };
  }

  return caption ? { role: "user", content: caption } : null;
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
          const userMessage = await buildUserMessage(message);
          if (!userMessage) {
            await sendMessage(
              chatId,
              "Kirim teks, kode, hex dump, gambar, atau file (maks 5 MB) yang mau dianalisa.",
            );
            return Response.json({ ok: true });
          }

          const { text } = await qwenChat([
            { role: "system", content: RE_SYSTEM_PROMPT },
            userMessage,
          ]);
          await sendMessage(chatId, text);
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
