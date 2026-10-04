import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Rendered instead of the children after a render/effect/lazy-load error. */
  fallback: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** When any value changes, a caught error is cleared and the children are tried again. */
  resetKeys?: readonly unknown[];
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}
interface State { error: Error | null }

const sameKeys = (a: readonly unknown[] = [], b: readonly unknown[] = []) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Contains a failure to one subtree instead of unmounting the whole app (React's default for uncaught render errors). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try { this.props.onError?.(error, info); } catch { /* a reporter must never re-break the fallback */ }
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  componentDidUpdate(prev: Props) {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null });
  }
  reset = () => this.setState({ error: null });
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const f = this.props.fallback;
    return typeof f === "function" ? f(error, this.reset) : f;
  }
}
