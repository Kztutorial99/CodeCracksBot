import { Sandbox } from "@e2b/code-interpreter";
import { getSandboxId, setSandboxId } from "@/lib/memory.server";

/** Sandbox stays alive between messages so installed packages persist. */
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 50_000;
const MAX_OUTPUT = 3000;

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export function e2bEnabled(): boolean {
  return Boolean(process.env["E2B_API_KEY"]);
}

function apiKey(): string {
  const key = process.env["E2B_API_KEY"];
  if (!key) throw new Error("E2B_API_KEY is not configured");
  return key;
}

/** Reuses the chat's sandbox when it is still alive, otherwise creates one. */
export async function getSandbox(chatId: number): Promise<Sandbox> {
  const key = apiKey();
  const existing = await getSandboxId(chatId);

  if (existing) {
    try {
      const sandbox = await Sandbox.connect(existing, { apiKey: key });
      await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
      return sandbox;
    } catch (error) {
      console.error("Sandbox reconnect failed, creating a new one", error);
    }
  }

  const sandbox = await Sandbox.create({ apiKey: key, timeoutMs: SANDBOX_TIMEOUT_MS });
  await setSandboxId(chatId, sandbox.sandboxId);
  return sandbox;
}

export async function resetSandbox(chatId: number): Promise<void> {
  const existing = await getSandboxId(chatId);
  await setSandboxId(chatId, null);
  if (!existing) return;
  try {
    await Sandbox.kill(existing, { apiKey: apiKey() });
  } catch (error) {
    console.error("Sandbox kill failed", error);
  }
}

function asExecResult(error: unknown): ExecResult {
  const e = error as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
  if (typeof e?.stdout === "string" || typeof e?.stderr === "string") {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.exitCode ?? 1 };
  }
  return { stdout: "", stderr: e?.message ?? String(error), exitCode: 1 };
}

/** Runs a shell command (package installs, git, curl, file tools). */
export async function runCommand(chatId: number, command: string): Promise<ExecResult> {
  const sandbox = await getSandbox(chatId);
  try {
    const result = await sandbox.commands.run(command, { timeoutMs: COMMAND_TIMEOUT_MS });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (error) {
    return asExecResult(error);
  }
}

/** Runs code in the persistent interpreter context (python by default). */
export async function runCode(
  chatId: number,
  code: string,
  language: "python" | "js" = "python",
): Promise<ExecResult> {
  const sandbox = await getSandbox(chatId);
  try {
    const execution = await sandbox.runCode(code, { language, timeoutMs: COMMAND_TIMEOUT_MS });
    const stdout = execution.logs.stdout.join("");
    const stderr = execution.logs.stderr.join("");
    const text = execution.text ? `${stdout}${stdout ? "\n" : ""}${execution.text}` : stdout;
    if (execution.error) {
      const err = [execution.error.name, execution.error.value, execution.error.traceback]
        .filter(Boolean)
        .join("\n");
      return { stdout: text, stderr: [stderr, err].filter(Boolean).join("\n"), exitCode: 1 };
    }
    return { stdout: text, stderr, exitCode: 0 };
  } catch (error) {
    return asExecResult(error);
  }
}

function clip(value: string): string {
  const trimmed = value.trimEnd();
  return trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, MAX_OUTPUT)}\n… (dipotong)` : trimmed;
}

/** Formats a result as markdown the Telegram renderer turns into code blocks. */
export function formatResult(result: ExecResult, title: string): string {
  const parts: string[] = [`${title} (exit ${result.exitCode ?? "?"})`];
  if (result.stdout.trim()) parts.push("```text\n" + clip(result.stdout) + "\n```");
  if (result.stderr.trim()) parts.push("stderr:\n```text\n" + clip(result.stderr) + "\n```");
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("_(tanpa output)_");
  return parts.join("\n\n");
}

/** Extracts the first fenced code block, or falls back to the raw text. */
export function extractCode(input: string): { code: string; language: "python" | "js" } {
  const fenced = /```([a-z0-9+#]*)\n([\s\S]*?)```/i.exec(input);
  if (fenced) {
    const tag = (fenced[1] ?? "").toLowerCase();
    const language = tag === "js" || tag === "javascript" || tag === "node" ? "js" : "python";
    return { code: fenced[2] ?? "", language };
  }
  return { code: input, language: "python" };
}
