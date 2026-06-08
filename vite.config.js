import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pullRecords } from "./jira-sync.mjs";

// Dev-server endpoint so the in-app "🔄 Refresh from Jira" button works:
// it runs the pull server-side (Node, has the token, no CORS) and returns the
// records the app imports directly. GET /api/jira-pull?open=1 for open-only.
const jiraEndpoint = {
  name: "jira-pull-endpoint",
  configureServer(server) {
    server.middlewares.use("/api/jira-pull", async (req, res) => {
      const open = /[?&]open=/.test(req.url || "");
      try {
        const records = await pullRecords({ open });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(records));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), jiraEndpoint],
  server: { host: true },
});
