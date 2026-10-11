// Test-only headless driver. Never bundled or exposed to the desktop webview.
use repopeek_core::{
    error::{Error, Result},
    git, history,
    models::*,
    service::{PreferencesPatch, Service},
    settings::SettingsStore,
};
use serde_json::{json, Value};
use std::io::{self, Read};

fn execute(request: Value) -> Result<Value> {
    let method = request["method"]
        .as_str()
        .ok_or_else(|| Error::new("Metodo mancante."))?;
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let string = |i: usize| -> Result<&str> {
        args.get(i)
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("Argomento non valido."))
    };
    let repo = || -> Result<Repository> {
        Ok(serde_json::from_value(
            args.first().cloned().unwrap_or(Value::Null),
        )?)
    };
    let target = || -> Result<Option<ChangeTarget>> {
        Ok(args
            .get(1)
            .filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()?)
    };
    Ok(match method {
        "resolveRepository" => json!(git::resolve_repository(string(0)?)?),
        "getStatus" => json!(git::get_status(&repo()?)),
        "getDiff" => json!(git::get_diff(&repo()?, string(1)?)),
        "stage" => {
            git::stage(&repo()?, target()?.as_ref())?;
            Value::Null
        }
        "unstage" => {
            git::unstage(&repo()?, target()?.as_ref())?;
            Value::Null
        }
        "commitStaged" => {
            git::commit_staged(&repo()?, string(1)?)?;
            Value::Null
        }
        "getOverview" => json!(history::get_overview(&repo()?)),
        "getLocalStatus" => json!(history::get_local_status(&repo()?)),
        "getHistory" => json!(history::get_history(string(0)?)?),
        "getHistoryPage" => {
            let cursor = args
                .get(1)
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value::<HistoryCursor>(v.clone()))
                .transpose()?;
            json!(history::get_history_page(&repo()?, cursor.as_ref())?)
        }
        "getCommitDiff" => json!(history::get_commit_diff(&repo()?, string(1)?, string(2)?)),
        "getDeploymentStatus" => json!(history::get_deployment_status(string(0)?)),
        "parseNumstat" => json!(history::parse_numstat(string(0)?.as_bytes())?),
        "settingsLoad" => {
            let store = SettingsStore::load(string(0)?.into());
            json!({"settings":store.get(), "warning":store.warning})
        }
        "settingsUpdate" => {
            let mut store = SettingsStore::load(string(0)?.into());
            json!(store.update(serde_json::from_value(args[1].clone())?)?)
        }
        "settingsReorder" => {
            let mut store = SettingsStore::load(string(0)?.into());
            let paths = serde_json::from_value(args[1].clone()).map_err(|_| {
                Error::new("La lista dei repository è cambiata. Aggiorna e riprova il riordino.")
            })?;
            json!(store.reorder(paths)?)
        }
        "service" => {
            let service = Service::new(string(0)?.into());
            service.run(|s| match string(1)? {
                "refresh" => Ok(json!(s.refresh()?)),
                "add" => Ok(json!(s.add(serde_json::from_value(args[2].clone())?)?)),
                "remove" => Ok(json!(s.remove(string(2)?)?)),
                "rename" => Ok(json!(s.rename(string(2)?, string(3)?)?)),
                "reorder" => Ok(json!(s.reorder(serde_json::from_value(args[2].clone())?)?)),
                "preferences" => Ok(json!(s.preferences(serde_json::from_value::<
                    PreferencesPatch,
                >(args[2].clone())?)?)),
                "stage" | "unstage" => {
                    let target = args
                        .get(3)
                        .filter(|v| !v.is_null())
                        .map(|v| serde_json::from_value::<ChangeTarget>(v.clone()))
                        .transpose()?;
                    Ok(json!(s.move_changes(
                        string(2)?,
                        target.as_ref(),
                        string(1)? == "stage"
                    )?))
                }
                "diff" => Ok(json!(s.diff(string(2)?, string(3)?)?)),
                "commitDiff" => Ok(json!(s.commit_diff(string(2)?, string(3)?, string(4)?)?)),
                _ => Err(Error::new("Metodo sconosciuto.")),
            })?
        }
        _ => return Err(Error::new("Metodo sconosciuto.")),
    })
}
fn main() {
    let mut input = String::new();
    let result = io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_string(&mut input)
        .map_err(Error::from)
        .and_then(|_| Ok(serde_json::from_str(&input)?))
        .and_then(execute);
    match result {
        Ok(value) => println!("{}", json!({"result":value})),
        Err(error) => {
            println!("{}", json!({"error":error.message}));
            std::process::exit(1);
        }
    }
}
