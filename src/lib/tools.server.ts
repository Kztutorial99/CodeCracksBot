import { formatResult, runCode, runCommand, e2bEnabled, getSandbox, resetSandbox } from "@/lib/e2b.server";

/** OpenAI-compatible tool schemas exposed to Qwen. Kept small and flat on purpose. */
export const SANDBOX_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "Execute Python code in a persistent Linux sandbox and return stdout/stderr. Use it whenever running code is the fastest way to get a correct answer: computing values, parsing/decoding data, unpacking or disassembling binaries, testing a script, crypto/hashing, regex checks. State (variables, files, installed packages) persists between calls in the same chat.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python source to execute." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a bash command in the same persistent Linux sandbox. Use for file inspection and RE tooling (ls, cat, file, strings, xxd, objdump, readelf, nm, unzip, curl, git, python3, node).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command line to run." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_package",
      description:
        "Install packages into the sandbox before using them. Call this when an import or binary is missing.",
      parameters: {
        type: "object",
        properties: {
          manager: { type: "string", enum: ["pip", "npm", "apt"], description: "Package manager." },
          packages: { type: "string", description: "Space separated package names." },
        },
        required: ["manager", "packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file into the sandbox working directory so later commands or scripts can use it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. /home/user/solve.py" },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
] as const;

export type ToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type ToolRun = {
  id: string;
  name: string;
  summary: string;
  output: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Executes one model-requested tool call and returns text fed back to the model. */
export async function executeToolCall(chatId: number, call: ToolCall): Promise<ToolRun> {
  const id = call.id ?? "call";
  const name = call.function?.name ?? "unknown";

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
  } catch {
    return { id, name, summary: name, output: "Invalid tool arguments JSON." };
  }

  if (!e2bEnabled()) {
    return { id, name, summary: name, output: "Sandbox unavailable: E2B_API_KEY is not configured." };
  }

  try {
    if (name === "run_python") {
      const code = String(args["code"] ?? "");
      const result = await runCode(chatId, code, "python");
      return { id, name, summary: "Menjalankan Python", output: formatResult(result, "python") };
    }

    if (name === "run_shell") {
      const command = String(args["command"] ?? "");
      const result = await runCommand(chatId, command);
      return { id, name, summary: `Shell: ${command.slice(0, 60)}`, output: formatResult(result, "bash") };
    }

    if (name === "install_package") {
      const manager = String(args["manager"] ?? "pip");
      const packages = String(args["packages"] ?? "").trim();
      if (!packages) return { id, name, summary: name, output: "No packages given." };
      const command =
        manager === "npm"
          ? `npm install --no-fund --no-audit ${packages}`
          : manager === "apt"
            ? `sudo apt-get install -y -qq ${packages}`
            : `pip install --quiet ${packages}`;
      const result = await runCommand(chatId, command);
      return { id, name, summary: `Install ${packages}`, output: formatResult(result, manager) };
    }

    if (name === "write_file") {
      const path = String(args["path"] ?? "");
      const content = String(args["content"] ?? "");
      if (!path) return { id, name, summary: name, output: "No path given." };
      const result = await runCommand(
        chatId,
        `mkdir -p "$(dirname ${shellQuote(path)})" && cat > ${shellQuote(path)} <<'CCB_EOF'\n${content}\nCCB_EOF`,
      );
      return {
        id,
        name,
        summary: `Tulis ${path}`,
        output: result.exitCode === 0 ? `Wrote ${path} (${content.length} bytes).` : formatResult(result, "write"),
      };
    }

    return { id, name, summary: name, output: `Unknown tool: ${name}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id, name, summary: name, output: `Tool failed: ${detail}` };
  }
}

export { getSandbox, resetSandbox };
