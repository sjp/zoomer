import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  crashed: boolean;
}

/**
 * Catches exceptions thrown while rendering the controls, so a UI bug shows a small
 * fallback instead of unmounting the whole app. The canvas sits outside this
 * boundary and keeps running.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("The control panel crashed:", error, info.componentStack);
  }

  override render() {
    if (!this.state.crashed) {
      return this.props.children;
    }
    return (
      <aside className="panel" role="alert">
        <p className="effect-error">The controls crashed. The background keeps running.</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </aside>
    );
  }
}
