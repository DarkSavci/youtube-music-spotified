import { Component, type ReactNode } from "react";

/** Keep navigation and playback mounted when a route fails to load/render. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="pagestate" role="alert">
      <h2>This page could not be opened</h2>
      <p>Reload the app to try again. Your saved sign-in and settings will stay.</p>
      <button className="chip chip--primary" onClick={() => window.location.reload()}>Reload app</button>
    </section>;
  }
}
