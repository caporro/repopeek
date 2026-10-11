use crate::{
    error::{Error, Result},
    models::*,
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub fn validate_settings(mut settings: Settings) -> Result<Settings> {
    if settings.version != 1
        || !matches!(
            settings.preferences.theme.as_str(),
            "system" | "dark" | "light"
        )
        || !matches!(settings.preferences.file_view.as_str(), "list" | "tree")
        || settings
            .repositories
            .iter()
            .any(|r| !Path::new(&r.path).is_absolute() || r.path.contains('\0'))
    {
        return Err(Error::new("Configurazione non valida."));
    }
    let mut repositories: Vec<Repository> = vec![];
    for mut repository in settings.repositories {
        if repository.name.as_deref() == Some("") {
            repository.name = None;
        }
        if let Some(existing) = repositories.iter_mut().find(|r| r.path == repository.path) {
            *existing = repository;
        } else {
            repositories.push(repository);
        }
    }
    settings.repositories = repositories;
    if settings.preferences.selected_repository.as_deref() == Some("") {
        settings.preferences.selected_repository = None;
    }
    Ok(settings)
}
pub struct SettingsStore {
    pub file: PathBuf,
    value: Settings,
    pub warning: Option<String>,
}
impl SettingsStore {
    pub fn load(file: PathBuf) -> Self {
        let mut store = Self {
            file,
            value: Settings::default(),
            warning: None,
        };
        match fs::read(&store.file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            result => {
                let parsed = result
                    .map_err(Error::from)
                    .and_then(|bytes| Ok(serde_json::from_slice::<Settings>(&bytes)?))
                    .and_then(validate_settings);
                match parsed {
                    Ok(settings) => store.value = settings,
                    Err(_) => store.warning = Some(format!("Configurazione non leggibile. Il file è stato preservato: {}. Correggilo o spostalo e riavvia RepoPeek.", store.file.display())),
                }
            }
        }
        store
    }
    pub fn get(&self) -> Settings {
        self.value.clone()
    }
    pub fn update(&mut self, next: Settings) -> Result<Settings> {
        if let Some(warning) = &self.warning {
            return Err(Error::new(warning));
        }
        let next = validate_settings(next)?;
        let parent = self
            .file
            .parent()
            .ok_or_else(|| Error::new("Percorso configurazione non valido."))?;
        fs::create_dir_all(parent)?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let temporary = parent.join(format!(
            ".repopeek-{}-{}-{}.tmp",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(&next)?)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temporary, &self.file)?;
            self.value = next;
            Ok(self.get())
        })();
        let _ = fs::remove_file(temporary);
        result
    }
    pub fn reorder(&mut self, paths: Vec<String>) -> Result<Settings> {
        let mut next = self.get();
        let paths_set: std::collections::HashSet<_> = paths.iter().collect();
        if paths.len() != next.repositories.len()
            || paths_set.len() != paths.len()
            || paths
                .iter()
                .any(|path| !next.repositories.iter().any(|r| &r.path == path))
        {
            return Err(Error::new(
                "La lista dei repository è cambiata. Aggiorna e riprova il riordino.",
            ));
        }
        next.repositories = paths
            .iter()
            .map(|path| {
                next.repositories
                    .iter()
                    .find(|r| &r.path == path)
                    .unwrap()
                    .clone()
            })
            .collect();
        self.update(next)
    }
}
