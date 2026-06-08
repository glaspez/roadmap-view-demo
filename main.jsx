import React from "react";
import { createRoot } from "react-dom/client";
import App from "./RoadmapBoss.jsx";

/* The artifact targets the Claude runtime, which provides window.storage.
   In a local/preview browser it doesn't exist, so we shim it with localStorage
   (same shape: get → {value}, throws if missing; set(key, value)). This lets
   the app persist config/backlog/AI-cache across reloads in the preview. */
if (!window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      if (v === null) throw new Error("not found: " + key);
      return { value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return true;
    },
  };
}

// DEV-ONLY: visit /?artifact=1 to simulate the Claude artifact runtime
// (provides window.claude.complete → hides the Refresh button, routes AI summaries
// through window.claude). Not part of the artifact — only RoadmapBoss.jsx is.
if (new URLSearchParams(location.search).has("artifact") && !window.claude) {
  window.claude = { complete: async () => "AI summary (simulated in dev)." };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
