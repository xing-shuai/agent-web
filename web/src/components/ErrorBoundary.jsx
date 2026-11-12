import React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { t } from "../i18n.js";

/**
 * Catches render errors so one bad component doesn't blank the whole app.
 * Pass `resetKey` (e.g. the session id) to auto-recover when it changes.
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="err-card">
        <AlertTriangle size={20} />
        <div className="err-title">{t("界面出现错误")}</div>
        <div className="err-msg">{String(error?.message || error)}</div>
        <button className="err-retry" onClick={() => this.setState({ error: null })}>
          <RotateCw size={14} /> {t("重试")}
        </button>
      </div>
    );
  }
}
