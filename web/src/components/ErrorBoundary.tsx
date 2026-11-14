// Contains a render failure to the view that failed: a small panel with the message and a retry,
// never a blank page. Errors are logged to the console with the view's name.
import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

interface Props {
  /** Shown in the panel and the console, e.g. "3D view (Moon)". */
  name: string;
  children: ReactNode;
  /** Compact variant for small areas such as a canvas pane. */
  compact?: boolean;
  /** Called before retrying, e.g. to clear cached state that caused the failure. */
  onRetry?: () => void;
  /** Changing this value clears a previous error (e.g. a new site was chosen). */
  resetKey?: string;
}

interface State {
  error: Error | null;
  key: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: undefined };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[view] ${this.props.name} failed to render:`, error, info.componentStack);
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ViewError name={this.props.name} message={error.message} compact={this.props.compact ?? false} onRetry={this.retry} />;
  }
}

function ViewError({
  name,
  message,
  compact,
  onRetry,
}: {
  name: string;
  message: string;
  compact: boolean;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className={compact ? 'view-error view-error-compact' : 'view-error'} role="alert">
      <p className="view-error-title">Couldn’t render this view: {name}</p>
      <p className="view-error-msg">{message || 'Unknown error'}</p>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
