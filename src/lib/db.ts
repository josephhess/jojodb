import { invoke } from "@tauri-apps/api/core";

export async function dbQuery<T = unknown>(sql: string): Promise<T> {
  return invoke("db_query", { sql });
}

export async function dbExecute(sql: string): Promise<number> {
  return invoke("db_execute", { sql });
}
