/* ───────────────────────────────────────────────────────────────────────────
   jira-sync.mjs — pull a Jira filter into Roadmap Boss.

   Two ways to use it:
     • In the app: click "🔄 Refresh from Jira" (the dev server calls pullRecords()
       below via /api/jira-pull — see vite.config.js). One click, no terminal.
     • CLI:  node jira-sync.mjs          → writes jira-export.json (full sync)
             node jira-sync.mjs --open   → writes jira-export-open.json (open only)
       then Import → Connector / JSON → Choose file.

   The Jira REST API honours `fields=` (like CSV column defaults), so payloads are
   tiny and the whole filter comes back in a couple of fast pages.

   ── ONE-TIME SETUP ─────────────────────────────────────────────────────────
   1. Create a Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens
   2. Put it in  .jira-credentials.json :  { "email": "you@pei.group", "token": "…" }
      (or set JIRA_EMAIL / JIRA_API_TOKEN env vars). Keep it private.

   Everything org-specific is in CONFIG — change it for another team/org.
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── CONFIG (edit for your org / filter) ───────────────────────────────────
export const CONFIG = {
  site: "peimedia.atlassian.net",
  jql: `project = WEB
    AND status IN (Cancelled, Done, "Code Review", "To Do", "Requirements Gathering",
      "Ready for Sprint", "Product Backlog", "PO Sign Off", Open, "In UX/design",
      "In Testing", "Issue Templates", "In Progress", Discovery, Blocked, Definition,
      "Awaiting Estimation", Analysis)
    AND sprint IN (2707, 2708, 2706, 2709, 2705, 2710, 2711)
    AND "engineering team[dropdown]" IN ("PA - ST7", "PA - ST8", "PA - ST11", "PA - ST9")
    AND type IN (Story, Bug, Spikes, Task, "Tech Debt")
    ORDER BY created DESC`,
  fields: {
    points: "customfield_10044",   // Story Points
    team:   "customfield_10178",   // Engineering Team  (value like "PA - ST7")
    sprint: "customfield_10021",   // Sprint (array)
  },
  includeDescription: true,
  outFile: "jira-export.json",
};

// ── credentials ───────────────────────────────────────────────────────────
function loadCreds() {
  try { return JSON.parse(readFileSync(new URL("./.jira-credentials.json", import.meta.url))); }
  catch { return { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN }; }
}

// ── transforms ──────────────────────────────────────────────────────────────
function adfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.text) return node.text;
  if (Array.isArray(node.content)) {
    const sep = node.type === "paragraph" || node.type === "heading" ? "\n" : "";
    return node.content.map(adfText).join(sep) + (sep ? "\n" : "");
  }
  return "";
}
function toRecord(it) {
  const F = CONFIG.fields, f = it.fields || {};
  const sprintArr = Array.isArray(f[F.sprint]) ? f[F.sprint] : [];
  const sprint = sprintArr.map(s => (s && s.name) || s).join(" ");
  const team = f[F.team] && (f[F.team].value || f[F.team].name || f[F.team]);
  return {
    id: it.key,
    title: f.summary || "",
    status: (f.status && f.status.name) || "",
    priority: (f.priority && f.priority.name) || "",
    parentSummary: (f.parent && f.parent.fields && f.parent.fields.summary) || "",
    sprint,
    points: f[F.points] != null ? f[F.points] : "",
    team: team || "",
    description: CONFIG.includeDescription ? adfText(f.description).trim() : "",
  };
}

// ── pull (exported; used by CLI and the dev-server endpoint) ─────────────────
export async function pullRecords({ open = false } = {}) {
  const creds = loadCreds();
  if (!creds.email || !creds.token) {
    throw new Error("Missing Jira credentials — create .jira-credentials.json { email, token } " +
      "or set JIRA_EMAIL / JIRA_API_TOKEN. Token: https://id.atlassian.com/manage-profile/security/api-tokens");
  }
  const AUTH = "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const F = CONFIG.fields;
  const fieldList = ["summary", "status", "priority", "parent", F.points, F.team, F.sprint]
    .concat(CONFIG.includeDescription ? ["description"] : []);
  let jql = CONFIG.jql.replace(/\s+/g, " ").trim();
  if (open) {
    jql = /order\s+by/i.test(jql)
      ? jql.replace(/\s+order\s+by/i, ' AND statusCategory != "Done" ORDER BY')
      : jql + ' AND statusCategory != "Done"';
  }
  const base = `https://${CONFIG.site}/rest/api/3/search/jql`;
  const out = [];
  let nextPageToken;
  do {
    const url = new URL(base);
    url.searchParams.set("jql", jql);
    url.searchParams.set("fields", fieldList.join(","));
    url.searchParams.set("maxResults", "100");
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira ${res.status} ${res.statusText}: ${await res.text()}`);
    const data = await res.json();
    (data.issues || []).forEach(it => out.push(toRecord(it)));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return out;
}

// ── CLI (only when run directly, not when imported by the dev server) ────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const open = process.argv.includes("--open");
  const outFile = open ? CONFIG.outFile.replace(/\.json$/, "-open.json") : CONFIG.outFile;
  console.log(`↻ Pulling from ${CONFIG.site}${open ? " (open tickets only)" : ""} …`);
  try {
    const records = await pullRecords({ open });
    if (records.length === 0) {
      console.error("✖ 0 tickets returned — check token/email or JQL. Not writing " + outFile + ".");
      process.exit(1);
    }
    writeFileSync(new URL("./" + outFile, import.meta.url), JSON.stringify(records, null, 2));
    console.log(`✓ Wrote ${records.length} tickets → ${outFile}`);
    console.log(open
      ? `  In the app: Import → Connector / JSON → ✅ "Update only" → Choose file → ${outFile}`
      : `  In the app: Import → Connector / JSON → Choose file → ${outFile}`);
  } catch (e) {
    console.error("✖ " + (e && e.message || e));
    process.exit(1);
  }
}
