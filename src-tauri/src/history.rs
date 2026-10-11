use crate::{
    error::{Error, Result},
    git::*,
    models::*,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const DIFF_OPTIONS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--find-renames=50%",
];

pub fn parse_numstat(output: &[u8]) -> Result<HashMap<String, LineStats>> {
    let output = text(output);
    let records: Vec<_> = output.split('\0').collect();
    let mut stats = HashMap::new();
    let mut i = 0;
    while i < records.len() && !records[i].is_empty() {
        let mut fields = records[i].splitn(3, '\t');
        let added = fields.next().unwrap_or("");
        let deleted = fields
            .next()
            .ok_or_else(|| Error::new("Statistiche Git non riconosciute."))?;
        let mut file = fields
            .next()
            .ok_or_else(|| Error::new("Statistiche Git non riconosciute."))?;
        if file.is_empty() {
            i += 2;
            file = records.get(i).copied().unwrap_or("");
        }
        if file.is_empty() {
            return Err(Error::new("Percorso Git mancante."));
        }
        let lines = if added == "-" || deleted == "-" {
            LineStats::unknown()
        } else {
            LineStats {
                added: added
                    .parse()
                    .map_err(|_| Error::new("Statistiche Git non valide."))?,
                deleted: deleted
                    .parse()
                    .map_err(|_| Error::new("Statistiche Git non valide."))?,
                unavailable: 0,
            }
        };
        stats.insert(file.into(), lines);
        i += 1;
    }
    Ok(stats)
}
struct RawChange {
    change: Change,
    before: String,
    after: String,
}
fn parse_raw(output: &[u8], hash: &str) -> Result<Vec<RawChange>> {
    let output = text(output);
    let records: Vec<_> = output.split('\0').collect();
    let mut result = vec![];
    let mut i = 0;
    while i < records.len() && !records[i].is_empty() {
        let fields: Vec<_> = records[i]
            .strip_prefix(':')
            .ok_or_else(|| Error::new("Modifiche Git non riconosciute."))?
            .split(' ')
            .collect();
        if fields.len() != 5 {
            return Err(Error::new("Modifiche Git non riconosciute."));
        }
        let code = fields[4].as_bytes().first().copied().unwrap_or(0);
        i += 1;
        let previous = records
            .get(i)
            .copied()
            .ok_or_else(|| Error::new("Percorso Git mancante."))?;
        let renamed = matches!(code, b'R' | b'C');
        let file = if renamed {
            i += 1;
            records
                .get(i)
                .copied()
                .ok_or_else(|| Error::new("Percorso Git mancante."))?
        } else {
            previous
        };
        let mut change = Change::new(
            file,
            "commit",
            match code {
                b'A' | b'C' => "added",
                b'D' => "deleted",
                b'R' => "renamed",
                _ => "modified",
            },
        );
        change.key = format!("commit:{hash}:{file}");
        if renamed {
            change.previous_path = Some(previous.into());
        }
        if fields[0] == "160000" || fields[1] == "160000" {
            change.submodule = Some(Submodule {
                commit_changed: true,
                modified: false,
                untracked: false,
            });
        }
        result.push(RawChange {
            change,
            before: fields[2].into(),
            after: fields[3].into(),
        });
        i += 1;
    }
    Ok(result)
}
struct CommitData {
    subject: String,
    author: String,
    authored_at: String,
    body: String,
    parents: Vec<String>,
    entries: Vec<RawChange>,
}
struct CommitMetadata {
    hash: String,
    subject: String,
    author: String,
    authored_at: String,
    body: String,
    parents: Vec<String>,
}
fn commit_metadata(root: &str, hashes: &[&str]) -> Result<Vec<CommitMetadata>> {
    if hashes.is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec![
        "show",
        "-s",
        "--no-walk=unsorted",
        "-z",
        "--no-show-signature",
        "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%b",
    ];
    args.extend(hashes);
    args.push("--");
    let output = text(&git(root, &args)?);
    let fields: Vec<_> = output
        .strip_suffix('\0')
        .ok_or_else(|| Error::new("Metadati Git non riconosciuti."))?
        .split('\0')
        .collect();
    if fields.len() != hashes.len() * 6 {
        return Err(Error::new("Metadati Git non riconosciuti."));
    }
    fields
        .chunks_exact(6)
        .zip(hashes)
        .map(|(fields, hash)| {
            if fields[0] != *hash {
                return Err(Error::new("Ordine dei commit non riconosciuto."));
            }
            Ok(CommitMetadata {
                hash: fields[0].into(),
                parents: fields[1].split_whitespace().map(String::from).collect(),
                subject: fields[2].into(),
                author: fields[3].into(),
                authored_at: fields[4].into(),
                body: fields[5].trim_end().into(),
            })
        })
        .collect()
}
// --raw and --numstat share a single diff-tree traversal. Consume raw path fields
// by their record structure, preserving filenames containing colons, tabs or newlines.
fn raw_boundary(output: &[u8]) -> Result<usize> {
    let mut offset = 0;
    while output.get(offset) == Some(&b':') {
        let end = output[offset..]
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| Error::new("Modifiche Git non riconosciute."))?
            + offset;
        let code = output[offset..end]
            .split(|b| *b == b' ')
            .last()
            .and_then(|field| field.first());
        let paths = if matches!(code, Some(b'R' | b'C')) {
            2
        } else {
            1
        };
        offset = end + 1;
        for _ in 0..paths {
            offset += output[offset..]
                .iter()
                .position(|b| *b == 0)
                .ok_or_else(|| Error::new("Percorso Git mancante."))?
                + 1;
        }
    }
    Ok(offset)
}
fn commit_data(root: &str, hash: &str) -> Result<CommitData> {
    commit_changes(root, &commit_metadata(root, &[hash])?.remove(0))
}
fn commit_changes(root: &str, metadata: &CommitMetadata) -> Result<CommitData> {
    let hash = metadata.hash.as_str();
    let mut base = vec!["diff-tree", "--root", "--no-commit-id", "-r", "-z"];
    base.extend(DIFF_OPTIONS);
    let revisions: Vec<_> = metadata
        .parents
        .first()
        .map(|parent| vec![parent.as_str(), hash])
        .unwrap_or_else(|| vec![hash]);
    base.extend(["--raw", "--numstat", "--no-abbrev"]);
    base.extend(&revisions);
    base.push("--");
    let output = git(root, &base)?;
    let boundary = raw_boundary(&output)?;
    let mut entries = parse_raw(&output[..boundary], hash)?;
    let stats = parse_numstat(&output[boundary..])?;
    for entry in &mut entries {
        entry.change.lines = Some(if entry.change.submodule.is_some() {
            LineStats::unknown()
        } else {
            stats
                .get(&entry.change.path)
                .cloned()
                .unwrap_or_else(LineStats::unknown)
        });
    }
    Ok(CommitData {
        subject: metadata.subject.clone(),
        author: metadata.author.clone(),
        authored_at: metadata.authored_at.clone(),
        body: metadata.body.clone(),
        parents: metadata.parents.clone(),
        entries,
    })
}
fn summarize_changes(changes: &[Change]) -> FileCounts {
    let mut by_path: HashMap<&str, HashSet<&str>> = HashMap::new();
    for change in changes {
        by_path
            .entry(&change.path)
            .or_default()
            .insert(&change.kind);
    }
    let mut files = FileCounts::default();
    for kinds in by_path.values() {
        if kinds.contains("conflict") || (kinds.contains("deleted") && kinds.contains("untracked"))
        {
            files.modified += 1;
        } else if kinds.contains("added") || kinds.contains("untracked") {
            files.added += 1;
        } else if kinds.contains("deleted") {
            files.deleted += 1;
        } else {
            files.modified += 1;
        }
    }
    files
}
fn history_page(
    root: &str,
    limit: usize,
    cursor: Option<&HistoryCursor>,
    include_head: bool,
) -> Result<HistoryPage> {
    let raw_refs = text(&git(
        root,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?);
    let refs: Vec<_> = raw_refs
        .trim()
        .split('\n')
        .filter(|s| !s.is_empty())
        .collect();
    let head: Option<String> =
        match git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) {
            Ok(bytes) => Some(text(&bytes).trim().into()),
            Err(e) if e.code == Some(1) => None,
            Err(e) => return Err(e),
        };
    let revision = format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}",
            refs.join("\n"),
            head.as_deref().unwrap_or("")
        ))
    );
    if cursor.is_some_and(|cursor| cursor.revision != revision) {
        return Err(Error::new(
            "La cronologia è cambiata. Ricarica la lista per continuare.",
        ));
    }
    let mut tips: Vec<&str> = vec![];
    for record in &refs {
        let parts: Vec<_> = record.split('\0').collect();
        if parts.len() == 4
            && parts[3].is_empty()
            && (parts[2].starts_with("refs/heads/") || parts[2].starts_with("refs/remotes/"))
            && !tips.contains(&parts[0])
        {
            tips.push(parts[0]);
        }
    }
    if let Some(head) = &head {
        if !tips.contains(&head.as_str()) {
            tips.push(head);
        }
    }
    if tips.is_empty() {
        return Ok(HistoryPage {
            commits: vec![],
            head: None,
            next_cursor: None,
        });
    }
    let offset = cursor.map_or(0, |cursor| cursor.offset);
    let max_count = format!("--max-count={}", limit + 1);
    let skip = format!("--skip={offset}");
    let mut args = vec!["rev-list", "--date-order", &max_count, &skip];
    args.extend(tips);
    args.push("--");
    let hashes_output = text(&git(root, &args)?);
    let hashes: Vec<_> = hashes_output
        .trim()
        .split('\n')
        .filter(|s| !s.is_empty())
        .collect();
    let mut visible: Vec<_> = hashes.iter().take(limit).copied().collect();
    if include_head {
        if let Some(head) = &head {
            if !visible.contains(&head.as_str()) {
                visible.push(head);
            }
        }
    }
    let metadata = commit_metadata(root, &visible)?;
    let commits = crate::parallel::map(&metadata, 2, |metadata| -> Result<CommitSummary> {
        let hash = metadata.hash.as_str();
        let data = commit_changes(root, metadata)?;
        let mut branches = vec![];
        let mut remote_branches = vec![];
        let mut tags = vec![];
        for record in &refs {
            let parts: Vec<_> = record.split('\0').collect();
            if parts.len() != 4 || !parts[3].is_empty() {
                continue;
            }
            if (if parts[1].is_empty() {
                parts[0]
            } else {
                parts[1]
            }) != hash
            {
                continue;
            }
            if let Some(name) = parts[2].strip_prefix("refs/heads/") {
                branches.push(name.into());
            } else if let Some(name) = parts[2].strip_prefix("refs/remotes/") {
                remote_branches.push(name.into());
            } else if let Some(name) = parts[2].strip_prefix("refs/tags/") {
                tags.push(name.into());
            }
        }
        let changes: Vec<_> = data.entries.into_iter().map(|entry| entry.change).collect();
        Ok(CommitSummary {
            hash: hash.into(),
            subject: data.subject,
            author: data.author,
            authored_at: data.authored_at,
            body: data.body,
            parents: data.parents,
            branches,
            remote_branches,
            tags,
            files: summarize_changes(&changes),
            changes,
        })
    })
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    Ok(HistoryPage {
        commits,
        head,
        next_cursor: (hashes.len() > limit).then_some(HistoryCursor {
            offset: offset + limit as i64,
            revision,
        }),
    })
}
pub fn get_history(root: &str) -> Result<Vec<CommitSummary>> {
    Ok(history_page(root, 5, None, false)?.commits)
}
pub fn get_history_page(
    repository: &Repository,
    cursor: Option<&HistoryCursor>,
) -> Result<HistoryPage> {
    if resolve_repository(&repository.path)? != repository.path {
        return Err(Error::new("Repository non disponibile."));
    }
    if cursor.is_some_and(|c| {
        c.offset < 0
            || c.offset > 9_007_199_254_740_991
            || c.revision.len() != 64
            || !valid_hash(&c.revision)
    }) {
        return Err(Error::new("Pagina della cronologia non valida."));
    }
    history_page(&repository.path, 20, cursor, false)
}
pub fn get_deployment_status(root: &str) -> DeploymentStatus {
    let head = match git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) {
        Ok(bytes) => text(&bytes).trim().to_string(),
        Err(e) => {
            return if e.code == Some(1) {
                DeploymentStatus::Unborn
            } else {
                DeploymentStatus::Unavailable
            }
        }
    };
    let Ok(bytes) = git(
        root,
        &[
            "describe",
            "--tags",
            "--match",
            "[vV]*",
            "--long",
            "--always",
            "--abbrev=40",
            &head,
        ],
    ) else {
        return DeploymentStatus::Unavailable;
    };
    let value = text(&bytes);
    let value = value.trim();
    if let Some((prefix, oid)) = value.rsplit_once("-g") {
        if oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            if let Some((tag, count)) = prefix.rsplit_once('-') {
                if let Ok(ahead) = count.parse::<u64>() {
                    if ahead <= 9_007_199_254_740_991 {
                        return DeploymentStatus::Tagged {
                            tag: tag.into(),
                            ahead,
                        };
                    }
                }
            }
        }
    }
    if valid_hash(value) {
        DeploymentStatus::Untagged
    } else {
        DeploymentStatus::Unavailable
    }
}
fn local_line_stats(root: &str, changes: &[Change]) -> Result<Vec<Change>> {
    let mut staged_args = vec!["diff", "--cached", "--numstat", "-z"];
    staged_args.extend(DIFF_OPTIONS);
    staged_args.push("--");
    let mut working_args = vec!["diff", "--numstat", "-z"];
    working_args.extend(DIFF_OPTIONS);
    working_args.push("--");
    let staged = parse_numstat(&git(root, &staged_args)?)?;
    let working = parse_numstat(&git(root, &working_args)?)?;
    let untracked: Vec<_> = changes.iter().filter(|c| c.kind == "untracked").collect();
    let mut binary = HashSet::new();
    for chunk in untracked.chunks(128) {
        let mut args = vec!["check-attr", "-z", "diff", "--"];
        args.extend(chunk.iter().map(|c| c.path.as_str()));
        let attrs = text(&git(root, &args)?);
        let attrs: Vec<_> = attrs.split('\0').collect();
        for fields in attrs.chunks(3) {
            if fields.len() == 3 && fields[2] == "unset" {
                binary.insert(fields[0].to_string());
            }
        }
    }
    let mut result = vec![];
    for change in changes {
        let mut change = change.clone();
        let mut lines = LineStats::unknown();
        if change.submodule.is_none() && change.kind != "conflict" {
            if change.kind == "untracked" {
                if !binary.contains(&change.path) {
                    if let Ok(content) =
                        working_version(root, &change.path).and_then(|bytes| decode(&bytes))
                    {
                        let count = if content.is_empty() {
                            0
                        } else {
                            content.split('\n').count() - usize::from(content.ends_with('\n'))
                        };
                        lines = LineStats {
                            added: count as u64,
                            ..Default::default()
                        };
                    }
                }
            } else {
                lines = (if change.section == "staged" {
                    &staged
                } else {
                    &working
                })
                .get(&change.path)
                .cloned()
                .unwrap_or_else(LineStats::unknown);
            }
        }
        change.lines = Some(lines);
        result.push(change);
    }
    Ok(result)
}
fn apply_local_stats(status: &mut RepositoryStatus) {
    match local_line_stats(&status.repository.path, &status.changes) {
        Ok(changes) => status.changes = changes,
        Err(_) => {
            for change in &mut status.changes {
                change.lines = Some(LineStats::unknown());
            }
            status.stats_error =
                Some("Conteggi delle righe non disponibili. Riprova con Aggiorna.".into());
        }
    }
}
pub fn get_local_status(repository: &Repository) -> RepositoryStatus {
    let mut status = get_status(repository);
    if status.state != "unavailable" {
        apply_local_stats(&mut status);
    }
    status
}
pub fn get_overview(repository: &Repository) -> RepositoryOverview {
    let mut status = get_status(repository);
    if status.state == "unavailable" {
        return RepositoryOverview {
            status,
            commits: vec![],
            deployment: DeploymentStatus::Unavailable,
            history_error: None,
        };
    }
    apply_local_stats(&mut status);
    let (commits, history_error) = match history_page(&repository.path, 5, None, true) {
        Ok(page) => (page.commits, None),
        Err(_) => (
            vec![],
            Some("Cronologia non disponibile. Riprova con Aggiorna.".into()),
        ),
    };
    RepositoryOverview {
        status,
        commits,
        deployment: get_deployment_status(&repository.path),
        history_error,
    }
}
pub fn get_commit_diff(repository: &Repository, hash: &str, key: &str) -> DiffResult {
    commit_diff_inner(repository, hash, key).unwrap_or_else(|e| {
        DiffResult::failure(
            e,
            "Versione del commit non disponibile. Aggiorna la panoramica.",
        )
    })
}
fn commit_diff_inner(repository: &Repository, hash: &str, key: &str) -> Result<DiffResult> {
    let root = &repository.path;
    if !valid_hash(hash) || resolve_repository(root)? != *root {
        return Err(Error::new("Repository o commit non valido."));
    }
    let contains = format!("--contains={hash}");
    let reachable = text(&git(
        root,
        &[
            "for-each-ref",
            &contains,
            "--count=1",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?);
    if reachable.trim().is_empty() {
        git(root, &["merge-base", "--is-ancestor", hash, "HEAD"])?;
    }
    let data = commit_data(root, hash)?;
    let entry = data
        .entries
        .iter()
        .find(|entry| entry.change.key == key)
        .ok_or_else(|| Error::new("File non presente nel commit."))?;
    let absent = |oid: &str| oid.bytes().all(|b| b == b'0');
    if entry.change.submodule.is_some() {
        return Ok(DiffResult::message(
            "submodule",
            format!(
                "Submodule\nPrima: {}\nDopo: {}",
                if absent(&entry.before) {
                    "assente"
                } else {
                    &entry.before
                },
                if absent(&entry.after) {
                    "assente"
                } else {
                    &entry.after
                }
            ),
        ));
    }
    if entry
        .change
        .lines
        .as_ref()
        .is_some_and(|lines| lines.unavailable > 0)
    {
        return Err(Error::preview(
            "binary",
            "File binario: anteprima non disponibile.",
        ));
    }
    let before = if absent(&entry.before) {
        vec![]
    } else {
        read_blob(root, &entry.before)?
    };
    let after = if absent(&entry.after) {
        vec![]
    } else {
        read_blob(root, &entry.after)?
    };
    let original = decode(&before)?;
    let modified = decode(&after)?;
    let mut notes = vec![];
    if data.parents.len() > 1 {
        notes.push("Merge confrontato con il primo genitore.");
    }
    if original == modified {
        notes.push("Contenuto invariato: modifica di nome, tipo o permessi.");
    }
    Ok(DiffResult::Text {
        original,
        modified,
        original_label: data
            .parents
            .first()
            .map(|parent| parent[..7].into())
            .unwrap_or_else(|| "Prima del primo commit".into()),
        modified_label: hash[..7].into(),
        note: (!notes.is_empty()).then(|| notes.join(" ")),
    })
}
