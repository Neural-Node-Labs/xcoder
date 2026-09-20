import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // Embedded CodeGraph Explorer + its API proxy — both are served by the xcoder API
      // process (see server.ts's /codegraph-ui and /codegraph-api mounts), not Vite's dev
      // server, so they need the same forwarding as /api above. Without this, the CodeGraph
      // Explorer page's iframe (src="/codegraph-ui/") hits Vite's own origin instead — which
      // has nothing there — and silently falls back to serving index.html (the main xcoder app)
      // inside the iframe instead of CodeGraph.
      "/codegraph-ui": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/codegraph-api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
