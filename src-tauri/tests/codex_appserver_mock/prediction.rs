use super::*;
use nezha_lib::codex_appserver::{prediction_policy, task_bridge::ForwarderGuard};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) fn serve(
    script: &str,
    method: &str,
    id: Option<Value>,
    params: &Value,
    out: &mut BufWriter<std::io::StdoutLock<'static>>,
) -> bool {
    match method {
        "thread/queue/list" => {
            let cancelled = std::env::var("NEZHA_SAMPLE_ID").is_err()
                || std::env::var("NEZHA_SAMPLE_CANCEL_OBSERVED").is_ok();
            respond(
                out,
                id,
                &json!({"data": if cancelled { vec![] } else { vec![json!({})] }, "nextCursor": null}),
            );
        }
        "thread/goal/get" => respond(out, id, &json!({"goal": null})),
        "thread/sample" => {
            assert_eq!(params["threadId"], "thread-happy");
            assert_eq!(params["expectedTurnId"], "source-turn");
            assert_eq!(params["effort"], "high");
            assert_eq!(params["threadSource"], "composer_predictions");
            assert_eq!(params["turnTrigger"], "composer_predictions");
            assert_eq!(params["disableMcp"], true);
            assert_eq!(params["interruptOnCancel"], true);
            if script == "prediction" {
                respond(
                    out,
                    id,
                    &json!({"sourceTurnId":"source-turn", "responseId":"r", "text":"{\"suggestion\":\"Run the checks.\"}"}),
                );
            } else {
                std::env::set_var("NEZHA_SAMPLE_ID", id.unwrap().to_string());
            }
        }
        "thread/sample/cancel" => {
            let expected: Value =
                serde_json::from_str(&std::env::var("NEZHA_SAMPLE_ID").unwrap()).unwrap();
            assert_eq!(params["requestId"], expected);
            std::env::set_var("NEZHA_SAMPLE_CANCEL_OBSERVED", "true");
            respond(out, id, &json!({}));
        }
        _ => return false,
    }
    true
}

pub(super) fn run() -> bool {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for scene in [
                "prediction",
                "prediction_timeout",
                "prediction_cancel",
                "prediction_override",
            ] {
                let session = spawn_mock(scene).await;
                prediction_policy::set_enabled(true);
                session.start_thread().await.unwrap();
                assert!(session
                    .prediction_queue_is_clear("thread-happy")
                    .await
                    .unwrap());
                let guard = ForwarderGuard::new(1);
                let revision = session.prediction_context().revision;
                let future = session.sample_next_message(
                    "thread-happy",
                    "source-turn",
                    "prompt",
                    tokio::time::Instant::now()
                        + Duration::from_secs(if scene == "prediction_override" { 5 } else { 1 }),
                    &guard,
                    revision,
                );
                let started = tokio::time::Instant::now();
                let cancel = async {
                    if scene == "prediction_override" {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        session.set_model_override(Some(Some("other-model")), None);
                    }
                    if scene == "prediction_cancel" {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        guard.cancel();
                    }
                };
                let (result, _) = tokio::join!(future, cancel);
                if scene == "prediction_override" {
                    assert!(
                        started.elapsed() < Duration::from_millis(500),
                        "configuration change must cancel without waiting for sample timeout"
                    );
                }
                if scene == "prediction" {
                    assert_eq!(result.unwrap()["sourceTurnId"], "source-turn");
                } else {
                    assert!(result.is_err());
                    assert!(
                        session
                            .prediction_queue_is_clear("thread-happy")
                            .await
                            .unwrap(),
                        "cancel must reach the server with the exact sample request ID"
                    );
                }
                assert_eq!(session.status().thread.unwrap().id, "thread-happy");
                assert!(session.shutdown_confirmed().await.is_ok());
            }
            prediction_policy::set_enabled(false);
            true
        })
}
