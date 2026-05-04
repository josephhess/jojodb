import { invoke } from "@tauri-apps/api/core";

// Tauri rejects commands with a plain string, not an Error object.
// Normalize here so every caller can rely on err.message.
function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

export async function dbQuery<T = unknown>(sql: string): Promise<T> {
  try {
    return await invoke("db_query", { sql });
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function dbExecute(sql: string): Promise<number> {
  try {
    return await invoke("db_execute", { sql });
  } catch (err) {
    throw normalizeError(err);
  }
}
