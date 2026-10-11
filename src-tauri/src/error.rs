use std::fmt;

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub code: Option<i32>,
    pub reason: Option<&'static str>,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            reason: None,
        }
    }
    pub fn preview(reason: &'static str, message: &str) -> Self {
        Self {
            message: message.into(),
            code: None,
            reason: Some(reason),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self {
            message: e.to_string(),
            code: e.raw_os_error(),
            reason: None,
        }
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new(e.to_string())
    }
}
