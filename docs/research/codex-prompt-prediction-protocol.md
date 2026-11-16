# Codex prompt prediction: protocol compatibility gate

Validated 2026-11-16 for issue #122. This is a maintained compatibility record and reproduction guide, not approval to enable the feature without the remaining lifecycle/UI/end-to-end work (#123–#127). No UI changes.

## Verified binaries

| CLI | SHA-256 of tested executable | Controlled real-binary tests | Live model smoke |
| --- | --- | --- | --- |
| 0.165.0 (current Nezha configured CLI) | `d4b2e6a054ea1dfe53217f9d8942c5f8a9f4b76171a1e0bb76ced5759915300a` | 6 passed | OpenAI `gpt-6-astra`, parent medium, sample requests high: JSON suggestion, unchanged parent, no reverse requests, about 4.25 s |
| 0.167.0-alpha.4.1 (existing installed binary) | `83f5c2dd2ac2902e0d96ba5d8ccdd27d513f57df4a9ab73e06a5a518028e9a2f` | 6 passed | OpenAI `gpt-6.1-sol`, parent high, sample high: JSON suggestion, unchanged parent, no reverse requests, about 4.45 s |

These are exact tested builds, not a claim that every intermediate or newer version is safe. The public source commit below is a semantic reference; its identity with either executable has not been established. No CLI was installed or updated.

## Observed contract

- Enable experimental API in `initialize`. Sample accepts `threadId`, `expectedTurnId`, `prompt`, `effort`, `disableMcp`, `interruptOnCancel`, `threadSource`, and `turnTrigger`. The latter two accept the string `composer_predictions` on the tested live path.
- Sample requires a **loaded, persistent root thread**. An ephemeral parent returns `-32600: sample source must be a persistent root thread`; a missing source returns `-32600: thread/sample requires a loaded source`. Neither means the method is unsupported.
- `thread/sample/cancel` takes **`{requestId}`**, the ID of the pending sample request on the same connection. Its acknowledgement is `{}`; the sample request subsequently returns `-32603: sample canceled`. The acknowledgement alone is not evidence of cleanup.
- `ThreadSampleResponse` has `sourceTurnId`, `responseId`, nullable `text`, and optional input/cached/output token counts. A forced tool response returns null text.
- Sample inherits context after explicit parent compaction. The fixture proves the provider request contains the synthesized compaction summary, not just the initial raw user text.
- Tool interception was tested with the **actually advertised `exec_command`** and a harmless command that would create a sentinel in the isolated writable workspace. No sentinel, command execution event, or server request appeared. The test does not rely on a read-only sandbox denying the command.
- Parent `thread/read(includeTurns=true)` is unchanged; all fixture rollout file names and SHA-256 hashes are unchanged. `thread/loaded/list` contains only the parent after sample completion, with no sampled child retained. Closing the server and resuming the same durable parent in a fresh server succeeds (writer release).
- A held provider response remains blocked while the client cancels and starts a new parent turn. The new parent completes; the cancelled sample is rejected. Latest single-run cancellation acknowledgement / cancellation-to-parent-start observations: **0.71 / 5.35 ms** on 0.165.0 and **0.61 / 10.64 ms** on alpha, measured with `perf_counter`. These are controlled local samples, not production P95 claims; #127 owns the repeated performance comparison.

## Effort is a context update, not a top-level request rewrite

The provider must support cache-preserving reasoning updates. The deterministic fixture supplies an OpenAI-named provider, model metadata with `supports_reasoning_effort_updates=true` and `use_responses_lite=true`, and the reasoning-effort-override feature.

Observed request-level effort stays **medium / medium / medium** for parent → sample → parent continuation. The respective input `configuration_update` effort sequences are **[medium] / [medium, high] / [medium]**. This proves a sample-only high override without changing the next parent turn. Testing only the HTTP top-level `reasoning.effort` would give a false failure.

The installed ordinary CLI model cache advertises those capability flags for `gpt-6-astra` and `gpt-6.1-sol`, both of which advertise high in `model/list`. Live smoke tests validate accepted requests and parent preservation, while the loopback fixture verifies the actual configuration-update shape. Live provider internals are not observable through the sample response.

**Do not claim a high override for arbitrary custom providers or models solely because high appears in model/list.** Without the required model/provider capability, upstream can retain the parent effort. The product adapter must gate that combination or obtain an explicit Spec change; it must not change the parent effort to force the prediction policy.

## Reproduction

Python 3.11+, standard library only. Set an explicit existing executable; no account access is needed for the deterministic tests:

```powershell
$env:CODEX_PROBE_EXE = 'C:\path\to\codex.exe'
python -B -m unittest discover -s scripts/prediction_probe -v
python -B scripts/prediction_probe/probe.py --codex $env:CODEX_PROBE_EXE
```

The tests exercise the actual app-server over stdio and a loopback HTTP Responses fixture. They use a temporary CODEX_HOME and writable fixture directory, then close their processes before removing the temporary data. The checked-in model metadata is synthetic, carries no credentials, and exists only to force the effort-update capability boundary.

An explicit live check uses the CLI's existing login through app-server; it never reads credential files or private desktop login storage. It incurs model usage, creates a synthetic durable thread (required by sample), and archives it afterward:

```powershell
python -B scripts/prediction_probe/live.py --codex $env:CODEX_PROBE_EXE --model gpt-6-astra
```

The current live script uses a medium parent and high sample. It disables configured MCP/app/web integrations via process overrides, requests no tool use, and prints only model/capability/outcome/timing metadata, not the generated suggestion or conversation. It does not modify user config.

A test run without CODEX_PROBE_EXE skips the real-binary tests; that is **not** a compatibility pass. The response-classification test still runs. The classifier distinguishes explicit method/field incompatibility from missing-source errors and authentication/rate-limit/network/model failures; latter failures do not permanently mark a protocol unsupported. Error classification is replayed at the public RPC-response boundary; real service failures were not deliberately induced.

## Scope of the safety evidence

The forced built-in tool response exercises the sample-wide response interception path. A separately configured external MCP server was not invoked as part of this probe; no claim of testing each MCP integration is made. Live smoke tests are not substitutes for deterministic tool interception. Application-level notifications, attachment cleanup, sedimentation and cloud writeback remain integration obligations in #123/#126.

No product capability allowlist, settings default, session retention or prompt display is changed by this ticket. Product-level 20-cycle resource tests, UI screenshots and default enablement remain #127 acceptance gates.

## Source references

The permanent upstream [sample implementation](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/app-server/src/thread_sample.rs) and [integration tests](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/app-server/tests/suite/v2/thread_sample.rs) explain the ephemeral child, tool-response interception and cache-preserving effort update. The local real-binary results above, rather than a version inequality, establish the tested compatibility boundary.
