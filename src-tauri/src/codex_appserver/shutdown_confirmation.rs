//! Memoizes confirmed process exit, never a failed/expired reap attempt.
use std::future::Future;
use tokio::sync::Mutex;

pub async fn confirm(
    previous: &Mutex<Option<Result<(), String>>>,
    reap: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let mut previous = previous.lock().await;
    if let Some(Ok(())) = *previous { return Ok(()); }
    let result = reap.await;
    if result.is_ok() { *previous = Some(Ok(())); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_out_process_can_exit_and_be_confirmed_on_next_attempt() {
        let confirmation = Mutex::new(None);
        let (exit, mut process) = tokio::sync::mpsc::channel::<()>(1);
        let first = confirm(&confirmation, async {
            tokio::time::timeout(std::time::Duration::from_millis(1), process.recv())
                .await.map(|_| ()).map_err(|_| "process did not exit before deadline".into())
        }).await;
        assert!(first.is_err());
        exit.send(()).await.unwrap();
        let second = confirm(&confirmation, async {
            process.recv().await.ok_or_else(|| "process channel closed".into())
        }).await;
        assert!(second.is_ok());
        // Once the process has really exited, subsequent calls are idempotent.
        assert!(confirm(&confirmation, async { panic!("reaped a confirmed process twice") }).await.is_ok());
    }
}


