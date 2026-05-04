use log::{error, info};
use serde_json::Value;
use tokio_postgres::NoTls;

fn database_url() -> String {
    std::env::var("JOJODB_DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://localhost/your_database".to_string())
}

#[tauri::command]
async fn db_query(sql: String) -> Result<Value, String> {
    let (client, connection) =
        tokio_postgres::connect(&database_url(), NoTls)
            .await
            .map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn(async move {
        if let Err(err) = connection.await {
            eprintln!("postgres connection error: {err}");
        }
    });

    let messages = client
        .simple_query(&sql)
        .await
        .map_err(|err| err.to_string())?;

    let mut rows = Vec::new();
    for message in messages {
        if let tokio_postgres::SimpleQueryMessage::Row(row) = message {
            let mut obj = serde_json::Map::new();
            for (idx, column) in row.columns().iter().enumerate() {
                let value = match row.get(idx) {
                    Some(text) => Value::String(text.to_string()),
                    None => Value::Null,
                };
                obj.insert(column.name().to_string(), value);
            }
            rows.push(Value::Object(obj));
        }
    }

    Ok(Value::Array(rows))
}

#[tauri::command]
async fn db_execute(sql: String) -> Result<u64, String> {
    let (client, connection) =
        tokio_postgres::connect(&database_url(), NoTls)
            .await
            .map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn(async move {
        if let Err(err) = connection.await {
            eprintln!("postgres connection error: {err}");
        }
    });

    // simple_query uses the simple protocol (same as db_query) which gives
    // full Postgres error messages and handles ENUMs correctly.
    info!("db_execute: {sql}");
    let messages = client
        .simple_query(&sql)
        .await
        .map_err(|err| {
            let msg = err.to_string();
            error!("db_execute failed: {msg} | sql: {sql}");
            msg
        })?;

    // Count affected rows from the CommandComplete message.
    let affected = messages.iter().find_map(|msg| {
        if let tokio_postgres::SimpleQueryMessage::CommandComplete(n) = msg {
            Some(*n)
        } else {
            None
        }
    }).unwrap_or(0);

    Ok(affected)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok(); // load .env if present, silently ignore if missing
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![db_query, db_execute])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
