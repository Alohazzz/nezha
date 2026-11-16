# Prediction composer browser fixture

Run `pnpm exec vite --port 1435 --host 127.0.0.1` and open
`http://127.0.0.1:1435/src/test/fixtures/prediction-composer.html` in an isolated browser.
The real composer uses synthetic Tauri IPC responses; this is not a desktop or provider integration test.

- Focus the empty textarea, press bare Tab: suggestion becomes editable text, caret ends at position 115, submissions remain zero.
- Press Ctrl+Z once: entire accepted draft disappears, suggestion stays suppressed, submissions remain zero.
- New round restores a new suggestion. Shift+Tab must navigate without acceptance.
- Light/Dark switches the production theme classes. Set `main.dataset.width = "narrow"` for a narrow panel; remove it for wide.
- Capture both focus states in both themes and panel widths. The suggestion is limited to two lines; only focused input shows the Tab hint.

Native undo was verified with Chrome 157.0.8103.51 on Windows using CDP Input.dispatchKeyEvent (Tab key code 9; Ctrl+Z key code 90, modifiers 2), not simulated DOM KeyboardEvents. Desktop WebView and real provider acceptance belong to the integration acceptance ticket.
