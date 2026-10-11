use serde::{Deserialize, Serialize};

pub fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Repository {
    pub path: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub selected_repository: Option<String>,
    #[serde(default = "list_view")]
    pub file_view: String,
}
fn list_view() -> String {
    "list".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub repositories: Vec<Repository>,
    pub preferences: Preferences,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            repositories: vec![],
            preferences: Preferences {
                theme: "system".into(),
                selected_repository: None,
                file_view: list_view(),
            },
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LineStats {
    pub added: u64,
    pub deleted: u64,
    pub unavailable: u64,
}
impl LineStats {
    pub fn unknown() -> Self {
        Self {
            unavailable: 1,
            ..Default::default()
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileCounts {
    pub modified: usize,
    pub added: usize,
    pub deleted: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub commit_changed: bool,
    pub modified: bool,
    pub untracked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub key: String,
    pub path: String,
    pub section: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<LineStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submodule: Option<Submodule>,
}
impl Change {
    pub fn new(path: &str, section: &str, kind: &str) -> Self {
        Self {
            key: format!("{section}:{path}"),
            path: path.into(),
            section: section.into(),
            kind: kind.into(),
            previous_path: None,
            lines: None,
            submodule: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub repository: Repository,
    pub state: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub changes: Vec<Change>,
    pub changed_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub subject: String,
    pub parents: Vec<String>,
    pub branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub tags: Vec<String>,
    pub author: String,
    pub authored_at: String,
    pub body: String,
    pub files: FileCounts,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryCursor {
    pub offset: i64,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<HistoryCursor>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum DeploymentStatus {
    Tagged { tag: String, ahead: u64 },
    Untagged,
    Unborn,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOverview {
    #[serde(flatten)]
    pub status: RepositoryStatus,
    pub commits: Vec<CommitSummary>,
    pub deployment: DeploymentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DiffResult {
    Text {
        original: String,
        modified: String,
        original_label: String,
        modified_label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Conflict {
        content: String,
        message: String,
    },
    Message {
        reason: String,
        message: String,
    },
}
impl DiffResult {
    pub fn message(reason: &str, message: impl Into<String>) -> Self {
        Self::Message {
            reason: reason.into(),
            message: message.into(),
        }
    }
    pub fn failure(error: crate::error::Error, fallback: &str) -> Self {
        match error.reason {
            Some(reason) => Self::message(reason, error.message),
            None => Self::message("unavailable", fallback),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeTarget {
    pub path: String,
    pub kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub settings: Settings,
    pub statuses: Vec<RepositoryOverview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub refreshed_at: String,
}
#[derive(Serialize)]
pub struct RejectedRepository {
    pub path: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct AddResult {
    pub settings: Settings,
    pub rejected: Vec<RejectedRepository>,
}
