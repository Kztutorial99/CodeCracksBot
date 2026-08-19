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
