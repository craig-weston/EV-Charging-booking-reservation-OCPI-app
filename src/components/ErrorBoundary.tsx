import { Component, type ReactNode } from "react";
import { reportClientError } from "../app/errors";

/** Keeps a rendering bug from blanking the whole app: shows a way out and reports it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
    reportClientError(error, "render");
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot" role="alert">
        <div className="stack gap-12" style={{ maxWidth: 420, textAlign: "center" }}>
          <b>Something went wrong on this screen</b>
          <span className="small muted">It has been reported. Your bookings are safe: reload to carry on.</span>
          <div><button className="btn primary" onClick={() => location.reload()}>Reload</button></div>
        </div>
      </div>
    );
  }
}
