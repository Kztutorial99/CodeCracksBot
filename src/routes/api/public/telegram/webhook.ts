import { createFileRoute } from "@tanstack/react-router";
import { describeFile } from "@/lib/binary-preview";
import {
  e2bEnabled,
  extractCode,
  formatResult,
  getSandbox,
  listUploads,
  resetSandbox,
  runCode,
  runCommand,
  uploadBytes,
} from "@/lib/e2b.server";
import {
  clearHistory,
  clearStop,
  consumeStop,
  finishRun,
  getRun,
  loadHistory,
  memoryEnabled,
  requestStop,
  RUN_STALE_MS,
  saveMessages,
  startRun,
  updateRun,
} from "@/lib/memory.server";
import { AgentStopped, qwenAgent, RE_SYSTEM_PROMPT, type QwenMessage } from "@/lib/qwen.server";
import { executeToolCall, SANDBOX_TOOLS } from "@/lib/tools.server";
import {
  deriveTelegramWebhookSecret,
  downloadFile,
  safeEqual,
  deleteStatus,
  editStatus,
  pinMessage,
  sendChatAction,
  sendMessage,
  sendStatus,
  unpinMessage,
} from "@/lib/telegram.server";

const WELCOME = `CodeCracks — asisten Reverse Engineering (Qwen AI)

Ngobrol biasa saja. Tidak perlu perintah apa pun.

AI-nya punya sandbox Linux sendiri dan akan memakainya otomatis kalau memang
perlu — menjalankan kode, install paket, decode/unpack, cek header binary,
disassemble, uji script — lalu menjawab dari hasil yang benar-benar dijalankan.

Model juga dipilih otomatis:
- teks: qwen3.8-max
- kode & binary: qwen3-coder-plus
- gambar/screenshot: qwen3-vl-flash

Kirim apa saja untuk dianalisa:
- pertanyaan RE, snippet kode, disasm, hex dump, log debugger
- screenshot IDA/Ghidra/x64dbg atau UI aplikasi
- file .txt .c .py .js .asm .bin .exe .elf .dex .apk (maks ~5 MB)

Contoh: "hitung CRC32 string ini", "unpack APK ini dan lihat manifestnya",
"kenapa script ini error?" — AI langsung eksekusi sendiri di sandbox.

Opsional (manual): /run /sh /pip /npm /sandbox
/status lihat bot idle atau sedang jalan · /stop hentikan proses
/reset hapus memori · /help`;

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
async function buildUserMessage(
  chatId: number,
  message: TelegramMessage,
): Promise<QwenMessage | null> {
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
    const name = file_name ?? "upload.bin";
    const described = describeFile(name, bytes);

    // The real file is copied into the sandbox so the model can actually run
    // tools on it instead of guessing from a truncated preview.
    let sandboxNote = "";
    if (e2bEnabled()) {
      try {
        const path = await uploadBytes(chatId, name, bytes);
        sandboxNote = [
          "",
          `File aslinya sudah tersedia di sandbox: \`${path}\` (${bytes.length} bytes).`,
          "WAJIB kerjakan file itu dengan tool (run_shell/run_python) — jangan menebak dari",
          "potongan preview di bawah, dan jangan minta user menjalankan perintah apa pun.",
        ].join("\n");
      } catch (error) {
        console.error("Sandbox upload failed", error);
      }
    }

    return {
      role: "user",
      content: [
        caption || "Analisa file ini dari sudut pandang reverse engineering.",
        sandboxNote,
        "",
        described,
      ].join("\n"),
    };
  }

  return caption ? { role: "user", content: caption } : null;
}

/** Plain-text version of a message, used for the stored conversation history. */
function historyText(message: TelegramMessage, fallback: string): string {
  const caption = (message.text ?? message.caption ?? "").trim();
  if (message.photo?.length) return caption ? `[gambar] ${caption}` : "[gambar]";
  if (message.document) {
    const name = message.document.file_name ?? "file";
    return caption ? `[file ${name}] ${caption}` : `[file ${name}]`;
  }
  return caption || fallback;
}

type CommandHandled = { handled: true } | { handled: false };

async function handleSandboxCommand(
  chatId: number,
  command: string,
  argument: string,
): Promise<CommandHandled> {
  const sandboxCommands = ["/run", "/sh", "/bash", "/pip", "/npm", "/sandbox"];
  if (!sandboxCommands.includes(command)) return { handled: false };

  if (!e2bEnabled()) {
    await sendMessage(chatId, "Sandbox belum aktif: E2B_API_KEY belum diset di server.");
    return { handled: true };
  }

  await sendChatAction(chatId);

  if (command === "/sandbox") {
    if (argument.toLowerCase() === "reset") {
      await resetSandbox(chatId);
      await sendMessage(chatId, "Sandbox dihapus. Sandbox baru dibuat saat perintah berikutnya.");
      return { handled: true };
    }
    const sandbox = await getSandbox(chatId);
    const info = await runCommand(chatId, "uname -a; python3 --version; node --version 2>/dev/null");
    await sendMessage(
      chatId,
      `Sandbox aktif: \`${sandbox.sandboxId}\`\n\n` + formatResult(info, "Info"),
    );
    return { handled: true };
  }

  if (command === "/pip" || command === "/npm") {
    if (!argument) {
      await sendMessage(chatId, `Contoh: \`${command} requests\``);
      return { handled: true };
    }
    const install =
      command === "/pip"
        ? `pip install --quiet ${argument}`
        : `npm install --no-fund --no-audit ${argument}`;
    const result = await runCommand(chatId, install);
    await sendMessage(chatId, formatResult(result, `Install: ${argument}`));
    return { handled: true };
  }

  if (command === "/sh" || command === "/bash") {
    if (!argument) {
      await sendMessage(chatId, "Contoh: `/sh ls -la`");
      return { handled: true };
    }
    const result = await runCommand(chatId, argument);
    await sendMessage(chatId, formatResult(result, "Shell"));
    return { handled: true };
  }

  // /run
  if (!argument) {
    await sendMessage(chatId, "Contoh:\n`/run print(2 ** 32)`\natau kirim blok kode setelah /run.");
    return { handled: true };
  }
  const { code, language } = extractCode(argument);
  const result = await runCode(chatId, code, language);
  await sendMessage(chatId, formatResult(result, `Run (${language})`));
  return { handled: true };
}

const TOOL_LABEL: Record<string, string> = {
  run_python: "Menjalankan kode Python",
  run_shell: "Menjalankan perintah shell",
  install_package: "Menginstall paket",
  write_file: "Menulis file",
};

function firstArg(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value =
      parsed["command"] ?? parsed["code"] ?? parsed["package"] ?? parsed["path"] ?? "";
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  } catch {
    return "";
  }
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

        const raw = (message.text ?? "").trim();
        const command = raw.split(/\s+/)[0]?.toLowerCase().split("@")[0] ?? "";
        const argument = raw.slice(command.length).trim();

        if (command === "/start" || command === "/help") {
          await sendMessage(chatId, WELCOME);
          return Response.json({ ok: true });
        }

        if (command === "/status") {
          if (!memoryEnabled()) {
            await sendMessage(
              chatId,
              "Status butuh memori aktif: Supabase belum dikonfigurasi di server.",
            );
            return Response.json({ ok: true });
          }
          const state = await getRun(chatId);
          if (state === "unavailable") {
            await sendMessage(
              chatId,
              "Tabel `chat_run` belum ada. Jalankan `supabase/schema.sql` di SQL editor Supabase dulu.",
            );
            return Response.json({ ok: true });
          }
          const run = state;
          const fresh =
            run?.status === "running" &&
            Date.now() - new Date(run.updatedAt).getTime() < RUN_STALE_MS;
          if (run && fresh) {
            const seconds = Math.max(1, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
            await sendMessage(
              chatId,
              [
                "🔄 Status: *sedang mengerjakan sesuatu*",
                `Berjalan: ${seconds}s · langkah selesai: ${run.steps}`,
                run.detail ? `Sekarang: ${run.detail}` : "",
                "",
                "Kirim /stop kalau mau dihentikan.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            return Response.json({ ok: true });
          }
          await sendMessage(
            chatId,
            [
              "✅ Status: *idle* — tidak ada proses yang berjalan.",
              run?.status === "running"
                ? "(proses terakhir berhenti tanpa selesai, sudah dianggap mati)"
                : run?.detail
                  ? `Terakhir: ${run.detail}`
                  : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
          if (run?.status === "running") await finishRun(chatId, "berhenti tanpa selesai");
          return Response.json({ ok: true });
        }

        if (command === "/stop") {
          if (!memoryEnabled()) {
            await sendMessage(
              chatId,
              "Mode stop butuh memori aktif: Supabase belum dikonfigurasi di server.",
            );
            return Response.json({ ok: true });
          }
          const ok = await requestStop(chatId);
          await sendMessage(
            chatId,
            ok
              ? "⏹️ Stop diminta. Proses berhenti setelah langkah yang sedang jalan selesai."
              : "Gagal menyimpan permintaan stop. Jalankan tabel `chat_stop` dari supabase/schema.sql dulu.",
          );
          return Response.json({ ok: true });
        }

        if (command === "/reset") {
          await clearHistory(chatId);
          await sendMessage(
            chatId,
            memoryEnabled()
              ? "Riwayat percakapan dihapus. Mulai dari awal lagi."
              : "Memori belum aktif: Supabase belum dikonfigurasi di server.",
          );
          return Response.json({ ok: true });
        }

        // Telegram redelivers an update when the webhook answers slowly. Without
        // this guard the same message starts a second agent run and the chat
        // gets duplicate replies.
        const active = await getRun(chatId);
        if (
          active !== "unavailable" &&
          active?.status === "running" &&
          Date.now() - new Date(active.updatedAt).getTime() < RUN_STALE_MS
        ) {
          return Response.json({ ok: true, busy: true });
        }

        let statusId: number | null = null;
        try {
          const sandboxResult = await handleSandboxCommand(chatId, command, argument);
          if (sandboxResult.handled) return Response.json({ ok: true });

          await sendChatAction(chatId);
          const userMessage = await buildUserMessage(chatId, message);
          if (!userMessage) {
            await sendMessage(
              chatId,
              "Kirim teks, kode, hex dump, gambar, atau file (maks 5 MB) yang mau dianalisa.",
            );
            return Response.json({ ok: true });
          }

          await clearStop(chatId);
          await startRun(chatId, "menyiapkan analisa");
          const history = await loadHistory(chatId);
          // Earlier uploads still live in the sandbox; telling the model their
          // real paths stops it from inventing a filename on follow-up turns.
          const uploads = await listUploads(chatId);
          const filesNote: QwenMessage[] = uploads.length
            ? [
                {
                  role: "system",
                  content: [
                    "File yang sudah diupload user dan masih ada di sandbox:",
                    ...uploads.map((path) => `- ${path}`),
                    "Pakai path itu apa adanya lewat tool, jangan menebak nama file.",
                  ].join("\n"),
                },
              ]
            : [];
          const conversation: QwenMessage[] = [
            { role: "system", content: RE_SYSTEM_PROMPT },
            ...filesNote,
            ...history.map((m) => ({ role: m.role, content: m.content }) as QwenMessage),
            userMessage,
          ];

          // Live progress so long runs never look stuck.
          const lines: string[] = [];
          // Shown immediately (and pinned) so a long turn is visible from the start.
          const render = async (current: string) => {
            const body = [...lines, current].filter(Boolean).join("\n");
            if (statusId == null) {
              statusId = await sendStatus(chatId, body);
              // Pinned so the running status stays visible at the top of the chat.
              await pinMessage(chatId, statusId);
              await updateRun(chatId, { messageId: statusId });
            } else {
              await editStatus(chatId, statusId, body);
            }
            await updateRun(chatId, { detail: current.slice(0, 180), steps: lines.length });
          };

          await render("🔄 Mulai mengerjakan…");

          const { text } = await qwenAgent({
            messages: conversation,
            tools: e2bEnabled() ? SANDBOX_TOOLS : [],
            shouldStop: () => consumeStop(chatId),
            runTool: (call) => executeToolCall(chatId, call),
            onThinking: async (step) => {
              await sendChatAction(chatId);
              if (step > 0 || lines.length > 0) await render("🧠 Menganalisa hasil…");
            },
            onToolStart: async ({ name, args, index }) => {
              await sendChatAction(chatId);
              const label = TOOL_LABEL[name] ?? name;
              const detail = firstArg(args);
              await render(`⚙️ ${index}. ${label}${detail ? `: ${detail}` : ""} …`);
            },
            onStep: async (step) => {
              await sendChatAction(chatId);
              const label = TOOL_LABEL[step.name] ?? step.name;
              lines.push(`✅ ${lines.length + 1}. ${label} — ${step.summary}`.slice(0, 180));
              await render("🧠 Menganalisa hasil…");
            },
          });
          await unpinMessage(chatId, statusId);
          await deleteStatus(chatId, statusId);
          await finishRun(chatId, "selesai");
          await sendMessage(chatId, text);
          await saveMessages(chatId, [
            { role: "user", content: historyText(message, "(tanpa teks)") },
            { role: "assistant", content: text },
          ]);
        } catch (error) {
          try {
            await unpinMessage(chatId, statusId);
            await deleteStatus(chatId, statusId);
          } catch {
            // status message already gone
          }
          await finishRun(chatId, error instanceof AgentStopped ? "dihentikan" : "gagal");
          if (error instanceof AgentStopped) {
            const done = error.steps.length
              ? `\n\nLangkah yang sempat selesai:\n${error.steps
                  .map((s, i) => `${i + 1}. ${s.name} — ${s.summary}`.slice(0, 180))
                  .join("\n")}`
              : "";
            await sendMessage(chatId, `⏹️ Dihentikan atas permintaan kamu.${done}`);
            return Response.json({ ok: true, stopped: true });
          }
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
