import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Applied before the first paint (React hasn't rendered anything yet) so a previously-saved
// non-default theme doesn't flash the default "hologram" colors for one frame first.
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={(error, reset) => (
        <div role="alert" style={{ padding: 32, fontFamily: "monospace", color: "#ddd" }}>
          <h2>Something went wrong</h2>
          <p>The page hit an unexpected error. Your data is safe on the server.</p>
          <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>{error.message.slice(0, 300)}</pre>
          <button onClick={reset}>Try again</button> <button onClick={() => location.reload()}>Reload page</button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
