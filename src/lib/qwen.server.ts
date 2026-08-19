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
- MATCH THE QUESTION'S SIZE. Short/simple message (greeting, small talk, yes-no, one fact) -> answer in
  1-2 short sentences, no headings, no bullet lists, no preamble, no "let me explain", no summary at the end.
  Only go long when the user actually asks for depth (analysis, tutorial, full code, "jelaskan detail").
- Never pad: no restating the question, no filler intro/outro, no offering extra topics unless asked.
- Answer concisely and technically. Use short sections and code blocks.
- Output is rendered as Telegram HTML by the bot: write plain markdown, never raw HTML tags.
- ALWAYS put code in triple-backtick fenced blocks with a language tag (python, c, bash, x86asm, json) so Telegram syntax-highlights it; use the text tag for hex dumps and logs.
- Use single-backtick inline code for symbols, addresses, registers and file names.
- If input is a binary/hex/asm dump, identify format, notable strings, likely purpose, and next analysis steps.
- If input is an image (screenshot of code, disassembly, debugger, or app UI), read the visible text first, then analyse it.
- Refuse only clearly illegal requests (malware distribution, real-world piracy keys, attacking systems the user does not own); offer a defensive/educational alternative instead.
- Reply in the language the user writes in (Indonesian or English).

Sandbox tools (run_python, run_shell, install_package, write_file):
- You have a persistent Linux sandbox. USE IT PROACTIVELY and silently whenever executing something
  gives a more reliable answer than guessing: decoding/deobfuscating, computing hashes or checksums,
  parsing PE/ELF/DEX headers, unpacking archives, disassembling, testing a script, verifying a patch.
- The user must NEVER be asked to type a command. Never tell them to run /sh, /pip or /run, and never
  say "you can run this yourself" — just call the tool and report the real result.
- Install what you need (install_package) instead of saying a library is missing.
- Chain tools: install -> write_file -> run_shell -> read output -> conclude. Keep going until you have
  a real answer, then explain it.
- Base your final answer on actual tool output, not on assumptions. Show the relevant output briefly.
- Never answer with "install X then run Y" as the deliverable. Installing and running is YOUR job:
  call install_package, then write_file/run_shell/run_python, read the real output, and report what
  actually happened (found strings, decompiled source, header fields, error messages).
- If a tool fails, do not give up and do not hand the command to the user: try another package,
  another tool, or another technique in the sandbox until you have a real result or a proven dead end.
- When a file path is given to you (e.g. /home/user/uploads/...), always operate on that exact path.
- A fenced bash block with install/run commands is NEVER an acceptable answer when a file is involved:
  that is a sign you skipped your job. Run it yourself and paste the real output instead.
- For an uploaded file, the deliverable is the RESULT (decrypted/decompiled source, extracted strings,
  header dump, or the real error), never the recipe to get it.
- Only skip the sandbox for pure conceptual/theory questions.`;

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

/** Adapts answer length to the user's message: short in -> short out. */
export function lengthDirective(messages: QwenMessage[]): QwenMessage | null {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  if (hasImage(lastUser.content)) return null;
  const text = textOf(lastUser.content).trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const wantsDetail =
    /(jelaskan|detail|lengkap|panjang|step by step|tutorial|analisa|analisis|explain|why|kenapa|bagaimana|how do|write|buatkan|bikin|code|script)/i.test(
      text,
    );
  if (wantsDetail || words > 25 || text.includes("```")) return null;
  const limit = words <= 4 ? "maksimal 1 kalimat" : "maksimal 2-3 kalimat";
  return {
    role: "system",
    content: `Pesan user pendek. Jawab ${limit}, langsung ke inti, tanpa heading, tanpa bullet, tanpa basa-basi pembuka/penutup.`,
  };
}

export type QwenToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type QwenAssistantMessage = {
  role: "assistant";
  content?: string | null;
  tool_calls?: QwenToolCall[];
};

export type QwenAnyMessage =
  | QwenMessage
  | QwenAssistantMessage
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

type QwenChoiceMessage = { content?: string | null; tool_calls?: QwenToolCall[] };

async function callQwen(
  model: string,
  messages: QwenAnyMessage[],
  tools?: readonly unknown[],
  toolChoice: "auto" | "required" = "auto",
): Promise<QwenChoiceMessage> {
  const apiKey = process.env["QWEN_API_KEY"] ?? process.env["DASHSCOPE_API_KEY"];
  if (!apiKey) throw new Error("QWEN_API_KEY is not configured");

  const body: Record<string, unknown> = { model, messages, stream: false };
  if (tools && tools.length > 0) {
    body["tools"] = tools;
    body["tool_choice"] = toolChoice;
  }

  const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`Qwen ${model} failed [${response.status}]: ${detail}`);
    throw new Error(`Qwen request failed [${response.status}]: ${detail}`);
  }

  const data = (await response.json()) as { choices?: { message?: QwenChoiceMessage }[] };
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error("Qwen returned an empty response");
  return choice;
}

export async function qwenChat(
  messages: QwenMessage[],
  options?: { task?: QwenTask },
): Promise<{ text: string; model: string; task: QwenTask }> {
  const chosen = options?.task
    ? { model: MODELS[options.task], task: options.task }
    : pickModel(messages);

  const brevity = lengthDirective(messages);
  const finalMessages = brevity ? [...messages, brevity] : messages;

  const attempts: { model: string; task: QwenTask }[] = [chosen];
  if (chosen.task !== "text") attempts.push({ model: MODELS.text, task: "text" });

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const choice = await callQwen(attempt.model, finalMessages);
      const text = (choice.content ?? "").trim();
      if (!text) throw new Error("Qwen returned an empty response");
      return { text, model: attempt.model, task: attempt.task };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Answers that just hand shell commands to the user instead of running them. */
const INSTRUCTION_HINTS = [
  /\b(pip|pip3|apt|apt-get|npm|brew|luarocks)\s+install\b/i,
  /\b(jalankan|coba jalankan|silakan jalankan|ketik|run this|try running|you can run|execute this)\b/i,
  /```(bash|sh|shell|console)/i,
  /\b(langkah|steps?)\s*\d*\s*:?\s*(install|jalankan|run)\b/i,
  /\b(simpan (script|kode) ini|save this script|then run|lalu jalankan)\b/i,
];

function looksLikeInstructions(text: string): boolean {
  return INSTRUCTION_HINTS.some((re) => re.test(text));
}

/** Max model<->tool round trips before we force a final answer. */
const MAX_STEPS = 12;

/** How many times we force the model back into the sandbox per run. */
const MAX_NUDGES = 3;

export type AgentStep = { name: string; summary: string };

/** Thrown when the user asked the agent to stop mid-run (/stop). */
export class AgentStopped extends Error {
  readonly steps: AgentStep[];
  constructor(steps: AgentStep[]) {
    super("Agent stopped by user");
    this.name = "AgentStopped";
    this.steps = steps;
  }
}

/**
 * Agentic loop: the model decides on its own when to use the sandbox.
 * `runTool` executes one tool call and returns the text handed back to the model.
 */
export async function qwenAgent(params: {
  messages: QwenMessage[];
  tools: readonly unknown[];
  runTool: (call: QwenToolCall) => Promise<{ id: string; name: string; summary: string; output: string }>;
  onStep?: (step: AgentStep) => Promise<void> | void;
  /** Fired right before a tool runs, so the UI can show live progress. */
  onToolStart?: (info: { name: string; args: string; index: number }) => Promise<void> | void;
  /** Fired when the model is thinking (no tool call yet). */
  onThinking?: (step: number) => Promise<void> | void;
  /** Polled between steps and tools; when true the run aborts with AgentStopped. */
  shouldStop?: () => Promise<boolean> | boolean;
  /** Forces a tool call on the first step (used when the user uploaded a file). */
  forceFirstTool?: boolean;
}): Promise<{ text: string; model: string; task: QwenTask; steps: AgentStep[] }> {
  const chosen = pickModel(params.messages);
  // Every routed model (text, coding and vision) supports tool calling, so
  // screenshots can trigger sandbox work too.
  const toolsEnabled = params.tools.length > 0;
  const model = chosen.model;

  const brevity = lengthDirective(params.messages);
  const conversation: QwenAnyMessage[] = brevity
    ? [...params.messages, brevity]
    : [...params.messages];
  const steps: AgentStep[] = [];
  let nudges = 0;
  let forceTools = params.forceFirstTool === true;

  const stopped = async () => (params.shouldStop ? await params.shouldStop() : false);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (await stopped()) throw new AgentStopped(steps);
    const useTools = toolsEnabled && step < MAX_STEPS - 1;
    if (params.onThinking) await params.onThinking(step);
    let choice: QwenChoiceMessage;
    try {
      choice = await callQwen(
        model,
        conversation,
        useTools ? params.tools : undefined,
        useTools && forceTools ? "required" : "auto",
      );
    } catch (error) {
      if (model === MODELS.text) throw error;
      choice = await callQwen(
        MODELS.text,
        conversation,
        useTools ? params.tools : undefined,
        useTools && forceTools ? "required" : "auto",
      );
    }
    forceTools = false;

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = (choice.content ?? "").trim();
      if (!text) throw new Error("Qwen returned an empty response");
      // The model sometimes hands the user a list of commands instead of running
      // them. One corrective nudge turns that back into real sandbox work.
      if (useTools && nudges < MAX_NUDGES && looksLikeInstructions(text)) {
        nudges += 1;
        forceTools = true;
        conversation.push({ role: "assistant", content: text });
        conversation.push({
          role: "user",
          content:
            "STOP. Jangan berikan instruksi, script, atau blok bash untuk saya jalankan. " +
            "Kamu punya sandbox Linux dan file-nya sudah ada di sana. Kerjakan sendiri SEKARANG: " +
            "panggil install_package untuk paket yang kamu butuhkan, lalu write_file/run_shell/run_python " +
            "pada path file yang sudah disebutkan, baca output aslinya, ulangi dengan teknik lain kalau gagal, " +
            "dan baru laporkan hasil nyata (isi hasil decrypt/dekompilasi, string, atau error sebenarnya).",
        });
        continue;
      }
      return { text, model, task: chosen.task, steps };
    }

    conversation.push({ role: "assistant", content: choice.content ?? "", tool_calls: toolCalls });

    let index = 0;
    for (const call of toolCalls) {
      index += 1;
      if (params.onToolStart) {
        await params.onToolStart({
          name: call.function?.name ?? "tool",
          args: call.function?.arguments ?? "",
          index: steps.length + index,
        });
      }
      if (await stopped()) throw new AgentStopped(steps);
      const result = await params.runTool(call);
      steps.push({ name: result.name, summary: result.summary });
      if (params.onStep) await params.onStep({ name: result.name, summary: result.summary });
      conversation.push({
        role: "tool",
        tool_call_id: result.id,
        name: result.name,
        content: result.output,
      });
    }
  }

  if (await stopped()) throw new AgentStopped(steps);
  const final = await callQwen(model, [
    ...conversation,
    { role: "user", content: "Berhenti memakai tool. Berikan kesimpulan akhir dari hasil di atas sekarang." },
  ]);
  const text = (final.content ?? "").trim() || "Tidak ada jawaban akhir dari model.";
  return { text, model, task: chosen.task, steps };
}
