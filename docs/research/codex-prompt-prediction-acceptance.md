# Codex prompt prediction acceptance — 2026-11-16

Issue #127 closes the acceptance gates in the [original specification](../proposals/codex-structured-prompt-prediction-v1.md). Predictions now default on for missing settings, while explicit false remains false. Runtime capability, structured-mode, provider and lifecycle gates still apply; enabling the preference does not bypass them.

## Environment and scope

Windows desktop, actual Tauri/WebView2 150.0.4078.83; Codex 0.165.0 SHA256 `d4b2e6a054ea1dfe53217f9d8942c5f8a9f4b76171a1e0bb76ced5759915300a`, model `gpt-6-astra`, built-in `openai`, parent effort medium and sample effort high. The [protocol report](codex-prompt-prediction-protocol.md) documents exact supported builds (including separately probed 0.167.0-alpha.4.1), tool interception, history and real-model protocol checks. Unknown builds fail closed. Alpha was not repeated through this desktop runner.

The desktop fixture invokes real public Tauri commands and Channels through TaskManager, task_bridge, scheduler and prediction cache; it does not substitute an IPC mock or call thread/sample directly. The local Responses provider makes lifecycle/performance runs deterministic while retaining the real CLI and product adapter. The separate live smoke uses normal CLI authentication and the real model. No credentials or prompt contents are exported by diagnostics.

## Product acceptance

- 30 warm cycles: 21 ordinary turns plus 9 immediate/in-flight/returned cancellation races; 30 business completion events, no unexpected approval/input interaction. One retained source app-server was observed across checkpoints; generations changed correctly.
- 21 cold baseline cycles with prediction off and the same CLI/provider: 21 completions. Both source histories contain exactly one user message per submitted cycle and no prediction instruction. See [warm raw metadata](prediction-acceptance/warm-lifecycle-report.json), [cold metadata](prediction-acceptance/cold-lifecycle-report.json) and [summary](prediction-acceptance/summary.json).
- Global model/effort change invalidated both cached tasks while preserving the active Running task; all four [scenario assertions](prediction-acceptance/global-report.json) passed. Parent model effort remained medium after samples used high.
- [Live product smoke](prediction-acceptance/live-report.json) completed a real task and displayed a valid suggestion 4984.4 ms after done (sample RPC 4919.5 ms). No tool, approval or user-input request occurred. The synthetic live thread was [archived](prediction-acceptance/live-cleanup.json).
- Feature-off released the retained app-server: [zero remaining Codex children](prediction-acceptance/process-release.json). Cold resumes also exercised writer release. Existing exit coordinator tests cover bounded shutdown/races. Native tray Quit was not clicked: the available native automation could not safely target the tray. This is a UI coverage limitation, not evidence that tray exit was exercised. After release, only owned fixture app/provider/Vite processes were stopped.

## Timing

Milliseconds; median / nearest-rank P95 (`ceil(n * .95)`). Initial launch excluded. The first launch included an approximately 11.6-second cold startup outlier. These local-provider measurements characterize product/CLI overhead, not network-model latency.

| Metric | Warm | Cold | n |
|---|---:|---:|---:|
| Submit → actual turn/start RPC acknowledgement | 60.7 / 77.6 | 2701.9 / 2842.3 | 20 each |
| Submit → first Channel frame (may be user echo) | 82.9 / 100.8 | 2685.0 / 2822.0 | 20 each |
| Submit → first nonempty assistant content | 98.3 / 115.6 | 9207.7 / 9598.7 | 5 each |
| thread/read readiness RPC | 3.45 / 5.37 | — | 29 |
| sample cancel acknowledgement | 0.83 / 1.01 | — | 6 |

The assistant-content metric was collected in a focused six-cycle rerun, excluding initial launch, after concurrent test load ended. It is a smaller sample than the lifecycle/ack run. Cancel acknowledgement alone is not a child-reaping measurement. Metadata tracing requires both a debug build and `NEZHA_PREDICTION_DIAGNOSTICS=1`; normal execution is inert and release builds omit calls.

## Native UI and defects fixed

Actual WebView2 screenshots and DOM geometry cover light/dark, focused/unfocused, pending, ghost, disabled and accepted states, at 752 px and 292 px composer widths. Composer height remains 69 px, input wrapper 20 px and footer 33 px. Two-line suggestion text and Tab hint do not overlap controls. The narrow disabled/OFF baseline originally overflowed; allowing the model badge to shrink fixes it without hiding actions or changing height.

Native Tab inserted 41 characters at caret 41 without submitting. One Ctrl+Z restored empty input without resurrecting the ghost. Buffered [native interaction metadata](prediction-acceptance/ui-native-interaction.json) records trusted insertText, historyUndo and insertFromPaste events: second-RAF estimates 5.7, 4.6 and 2.9 ms respectively. This is three samples, and the typing tool produced a paste; it is not a physical-key latency benchmark. [Additional narrow geometry](prediction-acceptance/ui-visual-report.json) confirms unchanged bounds after accept/undo. A regression also verifies keyCode 229 hides the ghost even without compositionStart.

| State | Native screenshot |
|---|---|
| Pending before suggestion | [light wide pending](prediction-acceptance/light-wide-pending.png) |
| Focused light / dark | [light](prediction-acceptance/light-wide-focused.png), [dark](prediction-acceptance/dark-wide-focused.png) |
| Narrow focused / disabled | [dark narrow](prediction-acceptance/dark-narrow-focused.png), [light disabled](prediction-acceptance/light-narrow-disabled.png) |
| Native Tab / single undo | [accepted](prediction-acceptance/native-tab-accepted.png), [empty](prediction-acceptance/native-undo-empty.png) |
| Narrow accepted / undo | [accepted](prediction-acceptance/native-narrow-accepted.png), [empty](prediction-acceptance/native-narrow-undone.png) |

CDP did not listen despite the isolated WebView flags; no unrelated browser debugging endpoint was attached. The fixture exported geometry through existing project-scoped file commands, and native automation supplied screenshots and trusted keyboard input. Browser-only #125 evidence is supplementary, not substituted for these desktop checks.

## Reproduction and checks

1. Start `python scripts/prediction_probe/desktop_provider.py --port-file <evidence>/provider.port`. Run `desktop_setup.ps1 -EvidenceRoot <path-containing-prediction127-evidence> -CodexPath <exact-cli> -ProviderPort <port>`. This creates a synthetic Git project, isolated Nezha settings, Codex home and fake loopback credential; never point it at a user's profile.
2. Follow the repository nezha-build-launch skill. Back up index.html and temporarily replace its main.tsx entry with `/src/test/fixtures/prediction-desktop.tsx`. Launch the built app with child-only USERPROFILE, CODEX_HOME and WEBVIEW2_USER_DATA_FOLDER pointing at the fixture directories. Set the opt-in diagnostics environment variable and capture stdout/stderr. Do not alter global environment variables.
3. Use Run warm / Run cold with timing subset unchecked for the full lifecycle matrix, then checked for the focused assistant-content measurements. Save the first full reports as warm-lifecycle-report.json and cold-lifecycle-report.json before overwriting them. Run Global, create a suggestion, and capture native Tab/Undo/theme/width states; Export UI saves buffered event metadata. The fixture's optional one-shot acceptance-command.json supports unattended chaining, keyed by nonce. It is development-only and not shipped in index.html.
4. For live smoke, retain the isolated Nezha/WebView profile but use the CLI's normal authenticated home; invoke Live, disable predictions afterward, confirm child release, then archive only the synthetic thread. Never copy or log credentials.
5. `python scripts/prediction_probe/desktop_report.py <evidence>` regenerates summary/provider metadata from reports, RPC logs and synthetic histories. Restore the original index.html and remove public/acceptance-command.json before building/committing. Stop only fixture-owned processes.

Validation: integrated frontend suite **118 files / 1035 tests passed**, full ESLint passed at integration 5e883342. Final acceptance delta: **22/22 targeted tests**, scoped ESLint, `pnpm build` (including TypeScript), and Rust `prediction_setting_defaults_on_and_preserves_explicit_opt_out` passed. The latter was observed failing before default migration and passing afterward. Earlier integrated Rust acceptance/lifecycle suite passed 63 tests and 14 app-server mock tests; rare unsupported/timeout/budget/Plan/queue/error cases rely on those focused tests, not invented native screenshots. Build retains existing chunk-size and unrelated Rust warnings.
