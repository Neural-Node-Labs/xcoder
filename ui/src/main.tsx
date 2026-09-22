import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./theme";
import "./styles.css";

// Applied before the first paint (React hasn't rendered anything yet) so a previously-saved
// non-default theme doesn't flash the default "hologram" colors for one frame first.
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
