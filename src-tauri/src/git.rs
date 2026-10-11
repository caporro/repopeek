use crate::{
    error::{Error, Result},
    models::*,
};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    sync::{mpsc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
// Bound total Git work across refresh, pagination and previews.
static GIT_PROCESSES: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());
struct GitPermit;
impl GitPermit {
    fn acquire() -> Result<Self> {
        let (mutex, ready) = &GIT_PROCESSES;
        let active = mutex
            .lock()
            .map_err(|_| Error::new("Operazione interrotta."))?;
        let mut active = ready
            .wait_while(active, |active| *active >= 6)
            .map_err(|_| Error::new("Operazione interrotta."))?;
        *active += 1;
        Ok(Self)
    }
}
impl Drop for GitPermit {
    fn drop(&mut self) {
        let (mutex, ready) = &GIT_PROCESSES;
        *mutex.lock().unwrap_or_else(|error| error.into_inner()) -= 1;
        ready.notify_one();
    }
}

pub fn git(root: &str, args: &[&str]) -> Result<Vec<u8>> {
    git_limit(root, args, MAX_OUTPUT)
}
fn git_limit(root: &str, args: &[&str], limit: usize) -> Result<Vec<u8>> {
    let _permit = GitPermit::acquire()?;
    let mut command = Command::new("/usr/bin/git");
    command
        .args([
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.autoRefreshIndex=false",
            "-C",
            root,
        ])
        .args(args);
    for (key, _) in std::env::vars_os() {
        if key.as_bytes().starts_with(b"GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Kill the process group on timeout, including any hook child holding the pipes open.
    command.process_group(0);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let error_sender = sender.clone();
    thread::spawn(move || {
        let _ = sender.send((false, read_bounded(stdout, limit)));
    });
    thread::spawn(move || {
        let _ = error_sender.send((true, read_bounded(stderr, 64 * 1024)));
    });
    let start = Instant::now();
    let mut status = None;
    let mut bytes = None;
    let mut error_bytes = None;
    loop {
        // Wake on pipe completion instead of adding a fixed delay to every command.
        if let Ok((is_error, result)) = receiver.recv_timeout(Duration::from_millis(1)) {
            if is_error {
                error_bytes = Some(result);
            } else {
                bytes = Some(result);
            }
        }
        if status.is_none() {
            status = child.try_wait()?;
        }
        if status.is_some() && bytes.is_some() && error_bytes.is_some() {
            break;
        }
        if start.elapsed() >= Duration::from_secs(15) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            return Err(Error {
                message: "Git non ha risposto entro 15 secondi. Riprova con Aggiorna.".into(),
                code: None,
                reason: Some("timeout"),
            });
        }
        // Once both pipes close, wait for the exit without spinning on a disconnected channel.
        if bytes.is_some() && error_bytes.is_some() && status.is_none() {
            thread::sleep(Duration::from_millis(1));
        }
    }
    let bytes = bytes.unwrap()?;
    let error_bytes = error_bytes.unwrap()?;
    let status = status.unwrap();
    if bytes.len() > limit {
        return Err(Error::new("Risposta Git troppo grande."));
    }
    if !status.success() {
        let message: String = String::from_utf8_lossy(&error_bytes)
            .trim()
            .chars()
            .take(2000)
            .collect();
        return Err(Error {
            message: if message.is_empty() {
                "Operazione Git non riuscita.".into()
            } else {
                message
            },
            code: status.code(),
            reason: None,
        });
    }
    Ok(bytes)
}
fn read_bounded(reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}
pub fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
pub fn valid_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn resolve_repository(selected: &str) -> Result<String> {
    let directory = fs::canonicalize(selected)?;
    if !directory.is_dir() {
        return Err(Error::new("Seleziona una cartella."));
    }
    let root = directory
        .to_str()
        .ok_or_else(|| Error::new("Percorso non UTF-8."))?;
    if text(&git(root, &["rev-parse", "--is-inside-work-tree"])?).trim() != "true" {
        return Err(Error::new("La cartella non contiene un working tree Git."));
    }
    let top = text(&git(root, &["rev-parse", "--show-toplevel"])?);
    Ok(fs::canonicalize(top.strip_suffix('\n').unwrap_or(&top))?
        .to_string_lossy()
        .into_owned())
}
fn kind(code: u8) -> &'static str {
    match code {
        b'A' | b'C' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        _ => "modified",
    }
}
fn fields(record: &str, count: usize) -> Result<(Vec<&str>, &str)> {
    let mut rest = record;
    let mut parts = Vec::new();
    for _ in 0..count {
        let (part, tail) = rest
            .split_once(' ')
            .ok_or_else(|| Error::new("Risposta Git non riconosciuta."))?;
        parts.push(part);
        rest = tail;
    }
    Ok((parts, rest))
}
pub fn parse_status(output: &[u8], repository: &Repository) -> Result<RepositoryStatus> {
    let output = text(output);
    let records: Vec<_> = output.split('\0').collect();
    let mut changes = vec![];
    let mut branch = String::new();
    let mut oid = String::new();
    let mut append = |file: &str, section: &str, kind: &str, previous: Option<&str>, sub: &str| {
        let mut change = Change::new(file, section, kind);
        change.previous_path = previous.filter(|s| !s.is_empty()).map(String::from);
        if sub.starts_with('S') {
            let flags = sub.as_bytes();
            change.submodule = Some(Submodule {
                commit_changed: flags.get(1) == Some(&b'C'),
                modified: flags.get(2) == Some(&b'M'),
                untracked: flags.get(3) == Some(&b'U'),
            });
        }
        changes.push(change);
    };
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        if let Some(value) = record.strip_prefix("# branch.head ") {
            branch = value.into();
        } else if let Some(value) = record.strip_prefix("# branch.oid ") {
            oid = value.into();
        } else if let Some(file) = record.strip_prefix("? ") {
            append(file, "working", "untracked", None, "");
        } else if record.starts_with("u ") {
            let (parts, file) = fields(record, 10)?;
            append(file, "working", "conflict", None, parts[2]);
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            let renamed = record.starts_with("2 ");
            let (parts, file) = fields(record, if renamed { 9 } else { 8 })?;
            let previous = if renamed {
                i += 1;
                records.get(i).copied()
            } else {
                None
            };
            let xy = parts[1].as_bytes();
            if xy.len() != 2 {
                return Err(Error::new("Risposta Git non riconosciuta."));
            }
            for (position, section) in [(0, "staged"), (1, "working")] {
                if xy[position] != b'.' {
                    append(
                        file,
                        section,
                        kind(xy[position]),
                        if matches!(xy[position], b'R' | b'C') {
                            previous
                        } else {
                            None
                        },
                        parts[2],
                    );
                }
            }
        }
        i += 1;
    }
    if branch == "(detached)" {
        branch = format!("Detached · {}", &oid[..oid.len().min(7)]);
    }
    let changed_files = changes
        .iter()
        .map(|c| &c.path)
        .collect::<HashSet<_>>()
        .len();
    Ok(RepositoryStatus {
        repository: repository.clone(),
        state: if changes.is_empty() { "clean" } else { "dirty" }.into(),
        branch,
        head: valid_hash(&oid).then_some(oid),
        changes,
        changed_files,
        error: None,
        stats_error: None,
    })
}
pub fn get_status(repository: &Repository) -> RepositoryStatus {
    let result = (|| {
        if resolve_repository(&repository.path)? != repository.path {
            return Err(Error::new("Repository spostato."));
        }
        parse_status(
            &git(
                &repository.path,
                &[
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--branch",
                    "--no-ahead-behind",
                    "--untracked-files=all",
                    "--ignore-submodules=none",
                    "--find-renames=50%",
                ],
            )?,
            repository,
        )
    })();
    result.unwrap_or_else(|error: Error| RepositoryStatus {
        repository: repository.clone(),
        state: "unavailable".into(),
        branch: String::new(),
        head: None,
        changes: vec![],
        changed_files: 0,
        stats_error: None,
        error: Some(if error.reason == Some("timeout") {
            error.message
        } else if error.code == Some(libc::ENOENT) {
            "Cartella o Git non disponibile.".into()
        } else {
            "Repository non disponibile o non leggibile. Riprova con Aggiorna.".into()
        }),
    })
}
pub fn validate_target(target: &ChangeTarget) -> Result<()> {
    validate_relative_path(&target.path)?;
    if !matches!(target.kind.as_str(), "file" | "directory") {
        return Err(Error::new("File o cartella non valido."));
    }
    Ok(())
}
fn validate_relative_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 32_768
        || value.contains('\0')
        || Path::new(value).is_absolute()
        || value.split('/').any(|s| matches!(s, "" | "." | ".."))
    {
        return Err(Error::new("File o cartella non valido."));
    }
    Ok(())
}
fn mutation_paths(
    repository: &Repository,
    target: Option<&ChangeTarget>,
    section: &str,
) -> Result<Vec<String>> {
    if let Some(target) = target {
        validate_target(target)?;
    }
    let status = get_status(repository);
    if status.state == "unavailable" {
        return Err(Error::new(status.error.unwrap()));
    }
    let mut paths = vec![];
    for change in status.changes.iter().filter(|c| c.section == section) {
        let applies = target.is_none_or(|target| {
            change.path == target.path
                || (target.kind == "directory"
                    && change.path.starts_with(&format!("{}/", target.path)))
        });
        if applies {
            for file in std::iter::once(&change.path).chain(change.previous_path.iter()) {
                if !paths.contains(file) {
                    paths.push(file.clone());
                }
            }
        }
    }
    if paths.is_empty() {
        return Err(Error::new(if section == "working" {
            "Il file o la cartella non presenta più modifiche da aggiungere allo staging."
        } else {
            "Il file o la cartella non è più presente nello staging."
        }));
    }
    Ok(paths)
}
pub fn stage(repository: &Repository, target: Option<&ChangeTarget>) -> Result<()> {
    let paths = mutation_paths(repository, target, "working")?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&repository.path, &args)?;
    Ok(())
}
pub fn unstage(repository: &Repository, target: Option<&ChangeTarget>) -> Result<()> {
    let paths = mutation_paths(repository, target, "staged")?;
    let has_head = match git(
        &repository.path,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    ) {
        Ok(_) => true,
        Err(e) if e.code == Some(1) => false,
        Err(e) => return Err(e),
    };
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git(&repository.path, &args)?;
    Ok(())
}
pub fn commit_staged(repository: &Repository, message: &str) -> Result<()> {
    if message.trim().is_empty()
        || message.encode_utf16().count() > 10_000
        || message.contains('\0')
    {
        return Err(Error::new("Inserisci un messaggio di commit valido."));
    }
    let status = get_status(repository);
    if status.state == "unavailable" {
        return Err(Error::new(status.error.unwrap()));
    }
    if !status.changes.iter().any(|c| c.section == "staged") {
        return Err(Error::new(
            "Non ci sono modifiche nello staging da committare.",
        ));
    }
    git(&repository.path, &["commit", "-m", message.trim()])?;
    Ok(())
}
fn assert_size(size: usize) -> Result<()> {
    if size > MAX_FILE_BYTES {
        return Err(Error::preview(
            "large",
            "File troppo grande: la diff è disponibile fino a 2 MiB per versione.",
        ));
    }
    Ok(())
}
pub fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.contains(&0) {
        return Err(Error::preview(
            "binary",
            "File binario: anteprima non disponibile.",
        ));
    }
    let value = std::str::from_utf8(bytes).map_err(|_| {
        Error::preview(
            "binary",
            "File binario o codifica non UTF-8: anteprima non disponibile.",
        )
    })?;
    Ok(value.strip_prefix('\u{feff}').unwrap_or(value).into())
}
pub fn read_blob(root: &str, oid: &str) -> Result<Vec<u8>> {
    let size: usize = text(&git(root, &["cat-file", "-s", oid])?)
        .trim()
        .parse()
        .map_err(|_| Error::new("Blob Git non valido."))?;
    assert_size(size)?;
    git_limit(root, &["cat-file", "blob", oid], MAX_FILE_BYTES + 1024)
}
fn index_version(root: &str, file: &str) -> Result<Vec<u8>> {
    let listing = text(&git(root, &["ls-files", "--stage", "-z", "--", file])?);
    for entry in listing.split('\0') {
        if let Some((fields, name)) = entry.split_once('\t') {
            let fields: Vec<_> = fields.split(' ').collect();
            if name == file && fields.len() == 3 && fields[2] == "0" {
                return if fields[0] == "160000" {
                    Ok(format!("Subproject commit {}\n", fields[1]).into_bytes())
                } else {
                    read_blob(root, fields[1])
                };
            }
        }
    }
    Ok(vec![])
}
fn head_version(root: &str, file: &str) -> Result<Vec<u8>> {
    match git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]) {
        Err(e) if e.code == Some(1) => return Ok(vec![]),
        Err(e) => return Err(e),
        Ok(_) => {}
    }
    let listing = text(&git(root, &["ls-tree", "-z", "HEAD", "--", file])?);
    for entry in listing.split('\0') {
        if let Some((fields, name)) = entry.split_once('\t') {
            let fields: Vec<_> = fields.split(' ').collect();
            if name == file && fields.len() == 3 {
                return if fields[1] == "commit" {
                    Ok(format!("Subproject commit {}\n", fields[2]).into_bytes())
                } else {
                    read_blob(root, fields[2])
                };
            }
        }
    }
    Ok(vec![])
}
pub fn working_version(root: &str, file: &str) -> Result<Vec<u8>> {
    validate_relative_path(file)?;
    let root = Path::new(root);
    let target = root.join(file);
    let parent = fs::canonicalize(
        target
            .parent()
            .ok_or_else(|| Error::new("Percorso non valido."))?,
    )?;
    if !parent.starts_with(root) {
        return Err(Error::preview(
            "unavailable",
            "Percorso esterno al repository.",
        ));
    }
    let info = fs::symlink_metadata(&target)?;
    if info.file_type().is_symlink() {
        return Ok(fs::read_link(target)?.as_os_str().as_bytes().to_vec());
    }
    if !info.is_file() {
        return Err(Error::preview(
            "unavailable",
            "Questo percorso non è un file di testo.",
        ));
    }
    assert_size(info.len() as usize)?;
    let handle = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(target)?;
    let current = handle.metadata()?;
    if !current.is_file() {
        return Err(Error::preview(
            "unavailable",
            "Questo percorso non è un file regolare.",
        ));
    }
    assert_size(current.len() as usize)?;
    let bytes = read_bounded(handle, MAX_FILE_BYTES)?;
    assert_size(bytes.len())?;
    Ok(bytes)
}
pub fn get_diff(repository: &Repository, key: &str) -> DiffResult {
    diff_inner(repository, key).unwrap_or_else(|e| DiffResult::failure(e, "Impossibile leggere questa versione del file. Potrebbe essere cambiato: aggiorna la lista."))
}
fn diff_inner(repository: &Repository, key: &str) -> Result<DiffResult> {
    let status = get_status(repository);
    if status.state == "unavailable" {
        return Ok(DiffResult::message("unavailable", status.error.unwrap()));
    }
    let Some(change) = status.changes.iter().find(|c| c.key == key) else {
        return Ok(DiffResult::message(
            "unavailable",
            "Il file è cambiato o non presenta più modifiche. Aggiorna la lista.",
        ));
    };
    let root = &repository.path;
    let previous = change.previous_path.as_deref().unwrap_or(&change.path);
    if let Some(sub) = &change.submodule {
        let mut details = vec![];
        if change.section == "staged" {
            let before = text(&head_version(root, previous)?)
                .trim()
                .replace("Subproject commit ", "");
            let after = text(&index_version(root, &change.path)?)
                .trim()
                .replace("Subproject commit ", "");
            details.push(format!(
                "HEAD: {}\nStaging: {}",
                if before.is_empty() {
                    "assente"
                } else {
                    &before
                },
                if after.is_empty() { "assente" } else { &after }
            ));
        }
        if sub.commit_changed {
            details.push("Commit differente".into());
        }
        if sub.modified {
            details.push("File interni modificati".into());
        }
        if sub.untracked {
            details.push("File interni non tracciati".into());
        }
        return Ok(DiffResult::message(
            "submodule",
            format!(
                "Submodule\n{}",
                if details.is_empty() {
                    "Riferimento modificato".into()
                } else {
                    details.join("\n")
                }
            ),
        ));
    }
    let mut args = vec!["check-attr"];
    if change.section == "staged" {
        args.push("--cached");
    }
    args.extend(["-z", "diff", "--", &change.path]);
    let attrs = text(&git(root, &args)?);
    if attrs.split('\0').nth(2) == Some("unset") {
        return Err(Error::preview(
            "binary",
            "File contrassegnato come binario da Git: anteprima non disponibile.",
        ));
    }
    if change.kind == "conflict" {
        return match working_version(root, &change.path) {
            Ok(bytes) => Ok(DiffResult::Conflict {
                content: decode(&bytes)?,
                message: "Conflitto non risolto · contenuto attuale del file, in sola lettura."
                    .into(),
            }),
            Err(e) if e.code == Some(libc::ENOENT) => Ok(DiffResult::Conflict {
                content: String::new(),
                message: "Conflitto non risolto · file assente nel working tree.".into(),
            }),
            Err(e) => Err(e),
        };
    }
    let before = if change.kind == "untracked" {
        vec![]
    } else if change.section == "staged" {
        head_version(root, previous)?
    } else {
        index_version(root, previous)?
    };
    let after = if change.kind == "deleted" {
        vec![]
    } else if change.section == "staged" {
        index_version(root, &change.path)?
    } else {
        working_version(root, &change.path)?
    };
    let original = decode(&before)?;
    let modified = decode(&after)?;
    let note = (original == modified)
        .then(|| "Contenuto invariato: modifica di nome, tipo o permessi.".into());
    Ok(DiffResult::Text {
        original,
        modified,
        original_label: if change.section == "staged" {
            "Ultimo commit"
        } else {
            "Staging"
        }
        .into(),
        modified_label: if change.section == "staged" {
            "Staging"
        } else {
            "Working tree"
        }
        .into(),
        note,
    })
}
