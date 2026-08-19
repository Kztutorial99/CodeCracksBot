import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type StoredRole = "user" | "assistant";

export type StoredMessage = {
  role: StoredRole;
  content: string;
};

/** Number of previous messages replayed to the model. */
const HISTORY_LIMIT = 12;

let cached: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (cached) return cached;
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Supabase is not configured");
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function memoryEnabled(): boolean {
  return Boolean(process.env["SUPABASE_URL"] && process.env["SUPABASE_SERVICE_ROLE_KEY"]);
}

/** Last messages for a chat, oldest first. Never throws: memory is best-effort. */
export async function loadHistory(chatId: number): Promise<StoredMessage[]> {
  if (!memoryEnabled()) return [];
  try {
    const { data, error } = await client()
      .from("chat_messages")
      .select("role, content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    return ((data ?? []) as StoredMessage[]).reverse();
  } catch (error) {
    console.error("loadHistory failed", error);
    return [];
  }
}

export async function saveMessages(chatId: number, messages: StoredMessage[]) {
  if (!memoryEnabled() || messages.length === 0) return;
  try {
    const { error } = await client()
      .from("chat_messages")
      .insert(messages.map((m) => ({ chat_id: chatId, role: m.role, content: m.content })));
    if (error) throw error;
  } catch (error) {
    console.error("saveMessages failed", error);
  }
}

export async function clearHistory(chatId: number) {
  if (!memoryEnabled()) return;
  try {
    await client().from("chat_messages").delete().eq("chat_id", chatId);
  } catch (error) {
    console.error("clearHistory failed", error);
  }
}

export async function getSandboxId(chatId: number): Promise<string | null> {
  if (!memoryEnabled()) return null;
  try {
    const { data } = await client()
      .from("chat_sandbox")
      .select("sandbox_id")
      .eq("chat_id", chatId)
      .maybeSingle();
    return (data as { sandbox_id?: string } | null)?.sandbox_id ?? null;
  } catch (error) {
    console.error("getSandboxId failed", error);
    return null;
  }
}

export async function setSandboxId(chatId: number, sandboxId: string | null) {
  if (!memoryEnabled()) return;
  try {
    if (sandboxId === null) {
      await client().from("chat_sandbox").delete().eq("chat_id", chatId);
      return;
    }
    await client()
      .from("chat_sandbox")
      .upsert({ chat_id: chatId, sandbox_id: sandboxId, updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
  } catch (error) {
    console.error("setSandboxId failed", error);
  }
}

/**
 * Cancellation flag for a running agent turn. The webhook runs serverless, so a
 * /stop from another request can only be seen through shared storage.
 */
export async function requestStop(chatId: number): Promise<boolean> {
  if (!memoryEnabled()) return false;
  try {
    const { error } = await client()
      .from("chat_stop")
      .upsert({ chat_id: chatId, requested_at: new Date().toISOString() }, { onConflict: "chat_id" });
    if (error) throw error;
    return true;
  } catch (error) {
    console.error("requestStop failed", error);
    return false;
  }
}

export async function clearStop(chatId: number) {
  if (!memoryEnabled()) return;
  try {
    await client().from("chat_stop").delete().eq("chat_id", chatId);
  } catch (error) {
    console.error("clearStop failed", error);
  }
}

/** True when a /stop arrived; the flag is consumed so the next run starts clean. */
export async function consumeStop(chatId: number): Promise<boolean> {
  if (!memoryEnabled()) return false;
  try {
    const { data } = await client()
      .from("chat_stop")
      .select("chat_id")
      .eq("chat_id", chatId)
      .maybeSingle();
    if (!data) return false;
    await clearStop(chatId);
    return true;
  } catch (error) {
    console.error("consumeStop failed", error);
    return false;
  }
}

export type RunState = {
  status: "running" | "idle";
  detail: string | null;
  steps: number;
  messageId: number | null;
  startedAt: string;
  updatedAt: string;
};

/** A run that stopped updating is treated as dead (serverless can die mid-turn). */
export const RUN_STALE_MS = 3 * 60 * 1000;

export async function startRun(chatId: number, detail: string): Promise<void> {
  if (!memoryEnabled()) return;
  try {
    const now = new Date().toISOString();
    await client()
      .from("chat_run")
      .upsert(
        { chat_id: chatId, status: "running", detail, steps: 0, message_id: null, started_at: now, updated_at: now },
        { onConflict: "chat_id" },
      );
  } catch (error) {
    console.error("startRun failed", error);
  }
}

export async function updateRun(
  chatId: number,
  patch: { detail?: string; steps?: number; messageId?: number | null },
): Promise<void> {
  if (!memoryEnabled()) return;
  try {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.detail !== undefined) row["detail"] = patch.detail;
    if (patch.steps !== undefined) row["steps"] = patch.steps;
    if (patch.messageId !== undefined) row["message_id"] = patch.messageId;
    await client().from("chat_run").update(row).eq("chat_id", chatId);
  } catch (error) {
    console.error("updateRun failed", error);
  }
}

export async function finishRun(chatId: number, detail: string): Promise<void> {
  if (!memoryEnabled()) return;
  try {
    await client()
      .from("chat_run")
      .upsert(
        { chat_id: chatId, status: "idle", detail, message_id: null, updated_at: new Date().toISOString() },
        { onConflict: "chat_id" },
      );
  } catch (error) {
    console.error("finishRun failed", error);
  }
}

/** "unavailable" means the chat_run table is missing (schema not applied yet). */
export async function getRun(chatId: number): Promise<RunState | null | "unavailable"> {
  if (!memoryEnabled()) return null;
  try {
    const { data, error } = await client()
      .from("chat_run")
      .select("status, detail, steps, message_id, started_at, updated_at")
      .eq("chat_id", chatId)
      .maybeSingle();
    if (error) {
      if (error.code === "42P01") return "unavailable";
      throw error;
    }
    if (!data) return null;
    const row = data as {
      status: "running" | "idle";
      detail: string | null;
      steps: number | null;
      message_id: number | null;
      started_at: string;
      updated_at: string;
    };
    return {
      status: row.status,
      detail: row.detail,
      steps: row.steps ?? 0,
      messageId: row.message_id,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    console.error("getRun failed", error);
    return null;
  }
}
