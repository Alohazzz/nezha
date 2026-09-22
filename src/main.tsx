import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppConfirmHost } from "./components/AppConfirmDialog";
import { ToastProvider } from "./components/Toast";
import { NotificationsProvider } from "./hooks/useNotifications";
import { I18nProvider } from "./i18n";
import s from "./styles";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={s.errorBoundaryWrap}>
          <div style={s.errorBoundaryTitle}>Something went wrong</div>
          <pre style={s.errorBoundaryMessage}>{this.state.error.message}</pre>
          <button style={s.errorBoundaryBtn} onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <ToastProvider>
          <NotificationsProvider>
            <App />
            <AppConfirmHost />
          </NotificationsProvider>
        </ToastProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
