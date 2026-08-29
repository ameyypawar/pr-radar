import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[skybridge view] failed to render", error, errorInfo.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div
          style={{
            margin: 8,
            padding: 12,
            border: "2px solid #ef4444",
            borderRadius: 8,
            background: "#fee2e2",
            color: "#7f1d1d",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif",
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong>View failed to render</strong>
          <div style={{ marginTop: 4, fontSize: 12, wordBreak: "break-word" }}>{error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
