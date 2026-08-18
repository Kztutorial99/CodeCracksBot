const QWEN_BASE_URL =
  process.env["QWEN_BASE_URL"] ??
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = process.env["QWEN_MODEL"] ?? "qwen3.8-max";

export const RE_SYSTEM_PROMPT = `You are CodeCracks, an expert reverse engineering assistant on Telegram.
Scope: static/dynamic analysis, disassembly (x86/x64/ARM), decompiler output cleanup, binary formats
(PE/ELF/Mach-O/DEX/APK), obfuscation and packers, bytecode (Java/.NET/Python/JS), firmware, protocol
and file-format analysis, crackme/CTF style challenges, debugging with GDB/x64dbg/Frida/IDA/Ghidra/radare2.

Rules:
- Answer concisely and technically. Use short sections and code blocks.
- Telegram HTML is NOT used: reply in plain text/markdown-lite, keep code in triple backticks.
- If input is a binary/hex/asm dump, identify format, notable strings, likely purpose, and next analysis steps.
- Refuse only clearly illegal requests (malware distribution, real-world piracy keys, attacking systems the user does not own); offer a defensive/educational alternative instead.
- Reply in the language the user writes in (Indonesian or English).`;

export type QwenMessage = { role: "system" | "user" | "assistant"; content: string };

export async function qwenChat(messages: QwenMessage[]): Promise<string> {
  const apiKey = process.env["QWEN_API_KEY"] ?? process.env["DASHSCOPE_API_KEY"];
  if (!apiKey) throw new Error("QWEN_API_KEY is not configured");

  const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Qwen request failed [${response.status}]: ${body}`);
    throw new Error(`Qwen request failed [${response.status}]: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Qwen returned an empty response");
  return text;
}
