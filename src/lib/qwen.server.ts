const QWEN_BASE_URL =
  process.env["QWEN_BASE_URL"] ??
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// Auto model routing — the user never picks a model.
export const MODELS = {
  text: process.env["QWEN_MODEL_TEXT"] ?? "qwen3.8-max",
  coding: process.env["QWEN_MODEL_CODING"] ?? "qwen3-coder-plus",
  vision: process.env["QWEN_MODEL_VISION"] ?? "qwen3-vl-flash",
} as const;

export type QwenTask = keyof typeof MODELS;

export const RE_SYSTEM_PROMPT = `You are CodeCracks, an expert reverse engineering assistant on Telegram.
Scope: static/dynamic analysis, disassembly (x86/x64/ARM), decompiler output cleanup, binary formats
(PE/ELF/Mach-O/DEX/APK), obfuscation and packers, bytecode (Java/.NET/Python/JS), firmware, protocol
and file-format analysis, crackme/CTF style challenges, debugging with GDB/x64dbg/Frida/IDA/Ghidra/radare2.

Rules:
- Answer concisely and technically. Use short sections and code blocks.
- Telegram HTML is NOT used: reply in plain text/markdown-lite, keep code in triple backticks.
- If input is a binary/hex/asm dump, identify format, notable strings, likely purpose, and next analysis steps.
- If input is an image (screenshot of code, disassembly, debugger, or app UI), read the visible text first, then analyse it.
- Refuse only clearly illegal requests (malware distribution, real-world piracy keys, attacking systems the user does not own); offer a defensive/educational alternative instead.
- Reply in the language the user writes in (Indonesian or English).`;

export type QwenTextContent = { type: "text"; text: string };
export type QwenImageContent = { type: "image_url"; image_url: { url: string } };
export type QwenContent = string | (QwenTextContent | QwenImageContent)[];
export type QwenMessage = { role: "system" | "user" | "assistant"; content: QwenContent };

const CODE_HINTS = [
  /```/,
  /\b(function|def |class |import |#include|public static|=>|const |let |var )\b/,
  /\b(0x[0-9a-f]{4,}|mov |push |pop |call |jmp |lea |xor )\b/i,
  /\b(segmentation fault|traceback|stack trace|gdb|x64dbg|ghidra|ida pro|radare2|frida|objdump|readelf)\b/i,
  /\.(c|cpp|h|py|js|ts|java|kt|go|rs|asm|s|dex|apk|exe|elf|so|dll|bin|smali)\b/i,
  /\b(refactor|debug|fix this code|write a script|deobfuscate|decompile|patch|hook)\b/i,
];

function hasImage(content: QwenContent): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

function textOf(content: QwenContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is QwenTextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Picks the best model automatically: vision > coding > best-quality text. */
export function pickModel(messages: QwenMessage[]): { model: string; task: QwenTask } {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.some((m) => hasImage(m.content))) {
    return { model: MODELS.vision, task: "vision" };
  }
  const prompt = userMessages.map((m) => textOf(m.content)).join("\n");
  if (CODE_HINTS.some((re) => re.test(prompt))) {
    return { model: MODELS.coding, task: "coding" };
  }
  return { model: MODELS.text, task: "text" };
}

export async function qwenChat(
  messages: QwenMessage[],
  options?: { task?: QwenTask },
): Promise<{ text: string; model: string; task: QwenTask }> {
  const apiKey = process.env["QWEN_API_KEY"] ?? process.env["DASHSCOPE_API_KEY"];
  if (!apiKey) throw new Error("QWEN_API_KEY is not configured");

  const chosen = options?.task
    ? { model: MODELS[options.task], task: options.task }
    : pickModel(messages);

  const attempts: { model: string; task: QwenTask }[] = [chosen];
  // Fallback chain so a single unavailable model never breaks the bot.
  if (chosen.task !== "text") attempts.push({ model: MODELS.text, task: "text" });

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: attempt.model, messages, stream: false }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`Qwen ${attempt.model} failed [${response.status}]: ${body}`);
        throw new Error(`Qwen request failed [${response.status}]: ${body}`);
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Qwen returned an empty response");
      return { text, model: attempt.model, task: attempt.task };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
