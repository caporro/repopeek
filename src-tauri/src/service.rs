use crate::{
    error::{Error, Result},
    git, history,
    models::*,
    settings::SettingsStore,
};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{Mutex, RwLock},
};

pub struct Service {
    store: Mutex<SettingsStore>,
    operations: RwLock<()>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesPatch {
    #[serde(default, deserialize_with = "optional_string")]
    pub theme: Option<String>,
    #[serde(default, deserialize_with = "optional_string")]
    pub selected_repository: Option<String>,
    #[serde(default, deserialize_with = "optional_string")]
    pub file_view: Option<String>,
}
impl Service {
    pub fn new(file: PathBuf) -> Self {
        Self {
            store: Mutex::new(SettingsStore::load(file)),
            operations: RwLock::new(()),
        }
    }
    // Writes exclude Git reads; independent reads do not queue behind other reads.
    pub fn run<T>(&self, action: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let _operation = self
            .operations
            .write()
            .map_err(|_| Error::new("Operazione interrotta."))?;
        action(self)
    }
    pub fn read<T>(&self, action: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let _operation = self
            .operations
            .read()
            .map_err(|_| Error::new("Operazione interrotta."))?;
        action(self)
    }
    fn store(&self) -> Result<std::sync::MutexGuard<'_, SettingsStore>> {
        self.store
            .lock()
            .map_err(|_| Error::new("Configurazione non disponibile."))
    }
    pub fn repository(&self, path: &str) -> Result<Repository> {
        self.store()?
            .get()
            .repositories
            .into_iter()
            .find(|r| r.path == path)
            .ok_or_else(|| Error::new("Repository non presente nella lista."))
    }
    pub fn settings(&self) -> Result<Settings> {
        Ok(self.store()?.get())
    }
    pub fn refresh(&self) -> Result<AppState> {
        let (settings, warning) = {
            let store = self.store()?;
            (store.get(), store.warning.clone())
        };
        let statuses = crate::parallel::map(&settings.repositories, 3, history::get_overview);
        Ok(AppState {
            settings,
            statuses,
            warning,
            refreshed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }
    pub fn add(&self, paths: Vec<String>) -> Result<AddResult> {
        let mut store = self.store()?;
        let mut settings = store.get();
        let mut rejected = vec![];
        let mut changed = false;
        for path in paths {
            match git::resolve_repository(&path) {
                Ok(canonical) if settings.repositories.iter().any(|r| r.path == canonical) => {
                    rejected.push(RejectedRepository {
                        path,
                        message: "Repository già presente.".into(),
                    })
                }
                Ok(canonical) => {
                    settings.repositories.push(Repository {
                        path: canonical,
                        name: None,
                    });
                    changed = true;
                }
                Err(_) => rejected.push(RejectedRepository {
                    path,
                    message: "Cartella non accessibile o repository Git non valido.".into(),
                }),
            }
        }
        Ok(AddResult {
            settings: if changed {
                store.update(settings)?
            } else {
                settings
            },
            rejected,
        })
    }
    pub fn remove(&self, path: &str) -> Result<Settings> {
        self.repository(path)?;
        let mut store = self.store()?;
        let mut settings = store.get();
        settings.repositories.retain(|r| r.path != path);
        if settings.preferences.selected_repository.as_deref() == Some(path) {
            settings.preferences.selected_repository = None;
        }
        store.update(settings)
    }
    pub fn reorder(&self, paths: Vec<String>) -> Result<Settings> {
        self.store()?.reorder(paths)
    }
    pub fn rename(&self, path: &str, name: &str) -> Result<Settings> {
        self.repository(path)?;
        if name.encode_utf16().count() > 120 || name.chars().any(|c| c <= '\u{1f}') {
            return Err(Error::new("Nome non valido (massimo 120 caratteri)."));
        }
        let mut store = self.store()?;
        let mut settings = store.get();
        let repo = settings
            .repositories
            .iter_mut()
            .find(|r| r.path == path)
            .unwrap();
        repo.name = (!name.trim().is_empty()).then(|| name.trim().into());
        store.update(settings)
    }
    pub fn preferences(&self, patch: PreferencesPatch) -> Result<Settings> {
        if let Some(path) = &patch.selected_repository {
            self.repository(path)?;
        }
        let mut store = self.store()?;
        let mut settings = store.get();
        if let Some(theme) = patch.theme {
            settings.preferences.theme = theme;
        }
        if let Some(path) = patch.selected_repository {
            settings.preferences.selected_repository = Some(path);
        }
        if let Some(view) = patch.file_view {
            settings.preferences.file_view = view;
        }
        store.update(settings)
    }
    pub fn move_changes(
        &self,
        path: &str,
        target: Option<&ChangeTarget>,
        staged: bool,
    ) -> Result<RepositoryStatus> {
        let repository = self.repository(path)?;
        if staged {
            git::stage(&repository, target)?;
        } else {
            git::unstage(&repository, target)?;
        }
        Ok(git::get_status(&repository))
    }
    pub fn diff(&self, path: &str, key: &str) -> Result<DiffResult> {
        validate_key(key)?;
        Ok(git::get_diff(&self.repository(path)?, key))
    }
    pub fn commit_diff(&self, path: &str, hash: &str, key: &str) -> Result<DiffResult> {
        validate_key(key)?;
        if !git::valid_hash(hash) {
            return Err(Error::new("Commit o file non valido."));
        }
        Ok(history::get_commit_diff(&self.repository(path)?, hash, key))
    }
}
fn validate_key(key: &str) -> Result<()> {
    if key.len() > 32_768 || key.contains('\0') {
        return Err(Error::new("File non valido."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};

    #[test]
    fn reads_overlap_while_writes_exclude_other_operations() {
        let service = Service::new(std::env::temp_dir().join("repopeek-lock-test/settings.json"));
        let timeout = Duration::from_secs(2);
        thread::scope(|scope| {
            let service = &service;
            let (entered, entry) = mpsc::channel();
            let (release, released) = mpsc::channel();
            scope.spawn(move || {
                service
                    .read(|_| {
                        entered.send(()).unwrap();
                        released.recv_timeout(timeout).unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            entry.recv_timeout(timeout).unwrap();
            let (done, completion) = mpsc::channel();
            scope.spawn(move || {
                service
                    .read(|_| {
                        done.send(()).unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            completion
                .recv_timeout(timeout)
                .expect("a history read must not block another read");
            let (written, write) = mpsc::channel();
            scope.spawn(move || {
                service
                    .run(|_| {
                        written.send(()).unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            assert!(write.recv_timeout(Duration::from_millis(50)).is_err());
            release.send(()).unwrap();
            write
                .recv_timeout(timeout)
                .expect("write must proceed after readers finish");
        });
        thread::scope(|scope| {
            let service = &service;
            let (entered, entry) = mpsc::channel();
            let (release, released) = mpsc::channel();
            scope.spawn(move || {
                service
                    .run(|_| {
                        entered.send(()).unwrap();
                        released.recv_timeout(timeout).unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            entry.recv_timeout(timeout).unwrap();
            let (done, completion) = mpsc::channel();
            scope.spawn(move || {
                service
                    .read(|_| {
                        done.send(()).unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            assert!(completion.recv_timeout(Duration::from_millis(50)).is_err());
            release.send(()).unwrap();
            completion
                .recv_timeout(timeout)
                .expect("read must proceed after write finishes");
        });
    }
}
