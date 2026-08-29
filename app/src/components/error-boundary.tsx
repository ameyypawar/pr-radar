import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useLayout, type Theme } from "skybridge/web";
import "../views/tokens.css";
import "./error-boundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function themeClass(theme: Theme | undefined): string {
  return theme === "dark" ? "sb-theme-dark" : theme === "light" ? "sb-theme-light" : "";
}

function ErrorFallback({ message }: { message: string }) {
  const { theme } = useLayout();
  return (
    <div className={`sb-root pr-error ${themeClass(theme)}`.trim()}>
      <strong>View failed to render</strong>
      <div className="pr-error-message">{message}</div>
    </div>
  );
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
      return <ErrorFallback message={error.message} />;
    }
    return this.props.children;
  }
}
