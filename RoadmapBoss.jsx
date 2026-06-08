import { useState, useRef, useEffect, useCallback, useMemo } from "react";

/* ═══════════════════════════════════════════════════════════════════════
   ROADMAP BOSS — white-label, multi-team roadmap & sprint-planning tool
   Base: PERE (dynamic teams/sprints/per-team capacity, CSV-as-source-of-truth)
   Roadmap tab: OBX gold-standard design + live AI summaries (cached)
   Config is data, not code — persisted to window.storage; INIT never overwrites.
   ═══════════════════════════════════════════════════════════════════════ */

// ── STORAGE KEYS ──────────────────────────────────────────
const STORAGE_KEY   = "rb-backlog-v1";
const HISTORY_KEY   = "rb-backlog-history-v1";
const CAPACITY_KEY  = "rb-sprint-capacity-v1";
const TEAM_CAP_KEY  = "rb-team-capacity-v1";
const CONFIG_KEY    = "rb-config-v1";
const AI_CACHE_KEY  = "rb-ai-summary-cache-v1";
const MAX_HISTORY   = 50;

// ── STATUS & PRIORITY ENUMS — per-org configurable ────────
// Defaults for brand-new projects / fallback. Everything below is editable in
// Settings. The mutable globals keep their original names so all call sites are
// unchanged; rebuildEnums() refreshes them from CFG whenever config changes.
const DEFAULT_STATUSES=[
  {name:"To Do",color:"#64748b",done:false},
  {name:"In Progress",color:"#3b82f6",done:false},
  {name:"In Testing",color:"#f59e0b",done:false},
  {name:"Code Review",color:"#14b8a6",done:false},
  {name:"Ready for Sprint",color:"#06b6d4",done:false},
  {name:"Product Backlog",color:"#8b5cf6",done:false},
  {name:"Awaiting Estimation",color:"#f97316",done:false},
  {name:"Requirements Gathering",color:"#ec4899",done:false},
  {name:"Analysis",color:"#a78bfa",done:false},
  {name:"PO Sign Off",color:"#84cc16",done:false},
  {name:"Blocked",color:"#ef4444",done:false},
  {name:"Done",color:"#22c55e",done:true},
  {name:"Cancelled",color:"#475569",done:true}
];
const DEFAULT_STATUS_ALIASES={"in ux/design":"In Progress"};
const DEFAULT_PRIORITIES=[
  {label:"🔴 Critical",color:"#ef4444"},
  {label:"🟠 High",color:"#f97316"},
  {label:"🟡 Medium",color:"#f59e0b"},
  {label:"🟢 Low",color:"#22c55e"}
];
// Mutable derived enums (original names preserved → call sites untouched).
let PRIORITY_OPTS=DEFAULT_PRIORITIES.map(p=>p.label);
let PRIORITY_ORDER=Object.fromEntries(DEFAULT_PRIORITIES.map((p,i)=>[p.label,i]));
let PRIORITY_COL=Object.fromEntries(DEFAULT_PRIORITIES.map(p=>[p.label,p.color]));
let STATUS_OPTS=DEFAULT_STATUSES.map(s=>s.name);
let STATUS_COL=Object.fromEntries(DEFAULT_STATUSES.map(s=>[s.name,s.color]));
let DONE_STATUSES=new Set(DEFAULT_STATUSES.filter(s=>s.done).map(s=>s.name));
let STATUS_MAP=(()=>{const m={};DEFAULT_STATUSES.forEach(s=>m[s.name.toLowerCase()]=s.name);Object.entries(DEFAULT_STATUS_ALIASES).forEach(([k,v])=>m[k]=v);return m;})();
// Role helpers — milestone scope follows priority ORDER, not exact labels.
function topPriority(){return PRIORITY_OPTS[0];}
function secondPriority(){return PRIORITY_OPTS[1]||PRIORITY_OPTS[0];}
function defaultPriority(){return PRIORITY_OPTS[Math.min(2,PRIORITY_OPTS.length-1)]||PRIORITY_OPTS[0];}
function rebuildEnums(){
  const sts=(CFG.statuses&&CFG.statuses.length)?CFG.statuses:DEFAULT_STATUSES;
  STATUS_OPTS=sts.map(s=>s.name);
  STATUS_COL=Object.fromEntries(sts.map(s=>[s.name,s.color||"#64748b"]));
  DONE_STATUSES=new Set(sts.filter(s=>s.done).map(s=>s.name));
  const m={}; sts.forEach(s=>m[s.name.toLowerCase()]=s.name);
  Object.entries(CFG.statusAliases||{}).forEach(([k,v])=>m[String(k).toLowerCase()]=v);
  STATUS_MAP=m;
  const pr=(CFG.priorities&&CFG.priorities.length)?CFG.priorities:DEFAULT_PRIORITIES;
  PRIORITY_OPTS=pr.map(p=>p.label);
  PRIORITY_ORDER=Object.fromEntries(pr.map((p,i)=>[p.label,i]));
  PRIORITY_COL=Object.fromEntries(pr.map(p=>[p.label,p.color||"#64748b"]));
}

const HOUR_OPTS=["Last 1 minute","Last 5 minutes","Last 1 hour","Last 12 hours","Last 24 hours"];
const HOUR_MS=[60000,300000,3600000,43200000,86400000];

const THEME_PALETTE=["#0284c7","#7c3aed","#db2777","#16a34a","#d97706","#dc2626","#0891b2","#4f46e5","#9333ea","#059669","#b45309","#0e7490"];
const TEAM_PALETTE=["#a78bfa","#f472b6","#fb923c","#34d399","#06b6d4","#f59e0b","#f87171","#38bdf8","#e879f9","#a3e635","#facc15","#60a5fa"];

const COLS=[
  {key:"team",label:"Team"},{key:"id",label:"ID"},{key:"theme",label:"Theme"},
  {key:"title",label:"Title"},{key:"priority",label:"Priority"},
  {key:"sprint",label:"Sprint"},{key:"points",label:"Pts"},{key:"status",label:"Status"}
];
const MERGE_FIELDS=[
  {key:"id",label:"ID"},{key:"title",label:"Title"},{key:"desc",label:"Desc"},
  {key:"team",label:"Team"},{key:"theme",label:"Theme"},{key:"priority",label:"Priority"},
  {key:"sprint",label:"Sprint"},{key:"points",label:"Pts"},{key:"status",label:"Status"},
  {key:"notes",label:"Notes"}
];

/* ═══════════════════════════════════════════════════════════════════════
   CONFIG LAYER — everything brand/team/sprint specific lives here as DATA.
   A mutable module-level CFG is read by the sprint helpers; App owns the
   React state and calls applyConfig() whenever it changes so helpers stay
   in sync without threading config through every function.
   ═══════════════════════════════════════════════════════════════════════ */
const DEFAULT_CONFIG={
  projectName:"Roadmap Boss",
  emoji:"🚀",
  subtitle:"Multi-team delivery programme",
  keyPrefix:"WEB",                 // generalised "primary" key prefix (merge + NEW filter)
  jiraBaseUrl:"",                  // e.g. https://yourco.atlassian.net  (blank → no deep links)
  setupComplete:false,
  // sprint model
  anchorNum:7,                     // the sprint number the anchor date refers to
  anchorISO:"2026-03-24",          // start date of the anchor sprint
  lengthDays:14,
  defaultTeamCap:36,               // pts per team per sprint
  // Key milestones to track delivery against — labels, dates & colours all
  // amendable in the Wizard/Settings. The Timeline & Roadmap automatically show
  // the next two upcoming milestones (scope 1 = top priority, scope 2 = top two).
  milestones:[
    {label:"Beta",date:"2026-06-29",color:"#7c3aed"},
    {label:"GA",date:"2026-07-28",color:"#0891b2"}
  ],
  // teams: display-name overrides + colours (keyed by canonical team id)
  teamNames:{},                    // {"ST7":"Squad 7"}
  teamColors:{},                   // {"ST7":"#a78bfa"}
  // How themes are assigned on import — org-agnostic by default:
  //  "epic"    → theme = the Jira epic / Parent summary (adapts to any org, no rules)
  //  "keyword" → PEI-specific keyword heuristic (epicToTheme) — opt-in, legacy
  //  "manual"  → don't infer; everything starts "Uncategorised", you assign
  themeSource:"epic",
  themeEpicStrip:"",               // optional prefix/regex stripped from epic names, e.g. "OBX PERE -"
  // themes — START EMPTY for new projects. Themes surface from imported data
  // (auto-coloured) and can be added/recoloured in the wizard, Settings, or any
  // ticket's Theme dropdown. We never assume a prior project's theme set.
  themes:{},
  // workflow statuses + priority levels (per-org, editable in Settings)
  statuses:DEFAULT_STATUSES,
  statusAliases:{...DEFAULT_STATUS_ALIASES},
  priorities:DEFAULT_PRIORITIES,
  // priority — protected by default; per-team unlock + Jira→our mapping
  protectPriority:true,
  priorityMapTeams:[],             // teams allowed to let Jira drive priority
  priorityMap:{                    // Jira's 4 values → our 4 states
    "Highest":"🔴 Critical","High":"🟠 High","Medium":"🟡 Medium","Low":"🟢 Low"
  }
};

let CFG={...DEFAULT_CONFIG};
function applyConfig(c){
  const cfg={...DEFAULT_CONFIG, ...c, themes:{...(c?.themes||{})}};
  // migrate legacy betaISO/gaISO → milestones
  if(c && !c.milestones && (c.betaISO||c.gaISO)){
    cfg.milestones=[
      {label:"Beta",date:c.betaISO||DEFAULT_CONFIG.milestones[0].date,color:"#7c3aed"},
      {label:"GA",date:c.gaISO||DEFAULT_CONFIG.milestones[1].date,color:"#0891b2"}
    ];
  }
  CFG=cfg; rebuildEnums();
}

// Theme colour: explicit config colour first, else a stable palette colour derived
// from the name (so data-discovered themes are consistently coloured, not grey).
function themeColor(name){
  if(!name) return "#64748b";
  if(CFG.themes&&CFG.themes[name]) return CFG.themes[name];
  return THEME_PALETTE[parseInt(hashStr(name))%THEME_PALETTE.length];
}
// Build a {theme: colour} map from the union of configured themes + themes in use.
function buildThemeMap(rows){
  const names=new Set(Object.keys(CFG.themes||{}));
  (rows||[]).forEach(r=>{ if(r.theme) names.add(r.theme); });
  const out={}; names.forEach(n=>{ out[n]=themeColor(n); }); return out;
}

// Team display + colour resolution (config first, then auto palette)
let _teamColIdx=0; const _teamColCache={};
function teamColor(team){
  if(!team) return "#64748b";
  if(CFG.teamColors&&CFG.teamColors[team]) return CFG.teamColors[team];
  if(_teamColCache[team]) return _teamColCache[team];
  const c=TEAM_PALETTE[_teamColIdx%TEAM_PALETTE.length]; _teamColIdx++; _teamColCache[team]=c; return c;
}
function teamLabel(team){ return (CFG.teamNames&&CFG.teamNames[team])||team; }

// Team ordering: ST-numbered first by number, then others alphabetically
function sortTeams(teams){
  return [...teams].sort((a,b)=>{
    const na=(a||"").match(/(\d+)/), nb=(b||"").match(/(\d+)/);
    const aSt=/^st/i.test(a||""), bSt=/^st/i.test(b||"");
    if(aSt&&bSt&&na&&nb) return Number(na[1])-Number(nb[1]);
    if(aSt&&!bSt) return -1; if(!aSt&&bSt) return 1;
    return (a||"").localeCompare(b||"");
  });
}

// ── SPRINT UTILITIES (config-driven) ──────────────────────
function anchorDate(){ const d=new Date(CFG.anchorISO+"T00:00:00"); return isNaN(d)?new Date("2026-03-24T00:00:00"):d; }
function sprintMs(){ return (CFG.lengthDays||14)*24*60*60*1000; }
function sprintStartDate(n){ return new Date(anchorDate().getTime()+(n-CFG.anchorNum)*sprintMs()); }
function sprintEndDate(n){ return new Date(anchorDate().getTime()+(n-CFG.anchorNum+1)*sprintMs()); }
function isExpiredAbs(n){ return Date.now()>sprintEndDate(n).getTime()+24*60*60*1000; }
function isActive(n){ const a=sprintStartDate(n); return Date.now()>=a.getTime()&&Date.now()<sprintEndDate(n).getTime(); }
function currentSprintNum(){
  for(let n=1;n<=80;n++){ if(isActive(n)) return n; }
  for(let n=1;n<=80;n++){ if(!isExpiredAbs(n)) return n; }
  return CFG.anchorNum;
}
function fmtDate(d){ if(!d) return ""; return d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }
function fmtDay(d){ if(!d) return ""; return d.toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }
function parseISO(d){ const x=new Date((d||"")+"T00:00:00"); return isNaN(x)?null:x; }
// all configured milestones, sorted by date
function milestoneList(){
  return (CFG.milestones||[]).map(m=>({label:m.label,color:m.color||"#7c3aed",iso:m.date,date:parseISO(m.date)}))
    .filter(m=>m.date).sort((a,b)=>a.date-b.date);
}
// the next two key milestones to track against (upcoming first; back-fill with
// the most recent if fewer than two remain in the future)
function trackedMilestones(){
  const all=milestoneList(); if(all.length<=2) return all;
  const cut=Date.now()-24*60*60*1000;
  const upcoming=all.filter(m=>m.date.getTime()>=cut);
  if(upcoming.length>=2) return upcoming.slice(0,2);
  if(upcoming.length===1){ const i=all.indexOf(upcoming[0]); return all.slice(Math.max(0,i-1),i+1); }
  return all.slice(-2);
}
// back-compat: the two tracked milestones' dates (scope 1 / scope 2)
function betaDate(){ return (trackedMilestones()[0]||{}).date||null; }
function gaDate(){ return (trackedMilestones()[1]||{}).date||null; }

const SPRINT_BASE_COL=["#a78bfa","#34d399","#60a5fa","#f472b6","#fb923c","#f87171","#38bdf8","#4ade80","#facc15","#e879f9","#a3e635","#f97316"];
function sprintCol(n){ if(!n||isNaN(n)) return "#64748b"; return SPRINT_BASE_COL[(n-1)%SPRINT_BASE_COL.length]; }
function sprintNumOf(s){ const m=String(s||"").match(/(\d+)/); return m?Number(m[1]):0; }

function normaliseSprint(v){
  if(!v||String(v).trim()==="") return "TBD";
  const s=String(v);
  const all=[...s.matchAll(/sprint\s+0*(\d+)/gi)].map(m=>Number(m[1]));
  if(all.length>0) return "Sprint "+Math.max(...all);
  // bare-number fallback — but ignore 4-digit years (e.g. "2026") so a sprint
  // cell without a "Sprint N" doesn't become a bogus "Sprint 2026"
  const m=s.match(/(?<!\d)(\d{1,3})(?!\d)/);
  return m?("Sprint "+Number(m[1])):"TBD";
}

// ── TEAM MAPPING (raw Jira value → canonical id) ──────────
function mapTeamFromRaw(raw){
  if(!raw) return null;
  const r=String(raw).toLowerCase().trim();
  const paM=r.match(/^[a-z]{1,4}\s*-\s*(.+)/);            // "PA - ST9" style prefix
  const body=paM?paM[1].trim():r;
  const stM=body.match(/st[\s-]*(\d+)/i);
  if(stM) return "ST"+stM[1];
  if(body.includes("data")) return "Data";
  if(!body) return null;
  // generic: title-case single token
  return body.replace(/\s+/g," ").trim().toUpperCase().replace(/\s/g,"-");
}

// ── THEME INFERENCE ───────────────────────────────────────
// Clean an epic / parent-summary into a tidy theme name: drop the leading issue
// key, an optional configured prefix, and surrounding separators.
function cleanEpicName(s){
  let v=(s||"").replace(/^[A-Z]+-\d+\s*/,"").trim();
  const strip=(CFG.themeEpicStrip||"").trim();
  if(strip){ try{ v=v.replace(new RegExp("^"+strip.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"),"").trim(); }catch(e){} }
  return v.replace(/^[-:–—\s]+/,"").trim();
}
// Org-agnostic theme resolution, driven by CFG.themeSource.
function inferTheme(parentSummary,summary){
  const mode=CFG.themeSource||"epic";
  if(mode==="manual") return "Uncategorised";
  if(mode==="keyword") return epicToTheme(parentSummary,summary)||"Uncategorised";
  return cleanEpicName(parentSummary)||"Uncategorised"; // "epic" (default)
}

// PEI-specific keyword heuristic — used only when themeSource === "keyword".
function epicToTheme(parentSummary,ticketSummary){
  const cleanParent=(parentSummary||"").replace(/^[A-Z]+-\d+\s*/,"");
  const t=(cleanParent+" "+ticketSummary).toLowerCase();
  if(t.includes("obx pere")&&t.includes("platform"))       return "Platform";
  if(t.includes("obx pere")&&t.includes("login"))          return "Registrations";
  if(t.includes("obx pere")&&t.includes("search"))         return "SEO / Platform";
  if((t.includes("obx pere")&&t.includes("askpei"))||(t.includes("obx pere")&&t.includes("ask pei"))) return "Ask PEI";
  if(t.includes("obx pere")&&t.includes("analytics"))      return "Analytics / Tracking";
  if(t.includes("pere - demo")||t.includes("demo request")) return "Request a Demo";
  if(t.includes("pere: registrations")||t.includes("pere - registrations")) return "Registrations";
  if(t.includes("pere: marketing")||t.includes("pere - marketing")) return "Marketing";
  if(t.includes("pere: seo")||t.includes("pere - seo"))    return "SEO / Platform";
  if(t.includes("pere: zephr")||t.includes("pere - zephr")) return "Platform";
  if(t.includes("pere: paywalls")||t.includes("pere - paywalls")||t.includes("editorial & homepage paywall")) return "Paywall";
  if(t.includes("pere - ads")||t.includes("pere: ads"))    return "Advertising";
  if(t.includes("pere - homepage")||t.includes("pere: homepage")) return "Homepage";
  if(t.includes("pere - watchlist")||t.includes("pere: watchlist")) return "Homepage";
  if(t.includes("pere - editorials")||t.includes("obx pere - editorial")) return "Editorial";
  if(t.includes("pere - navigation")||t.includes("pere: navigation")) return "Navigation / UX";
  if(t.includes("pere - listing")||t.includes("pere: listing")) return "Editorial";
  if(t.includes("pere - data")||t.includes("pere: data"))  return "Data Room";
  if(t.includes("pere - network")||t.includes("pere: network")||t.includes("network integration")) return "Platform";
  if(t.includes("newsletter"))                              return "Marketing";
  if(t.includes("ask pei")||t.includes("askpei"))           return "Ask PEI";
  if(t.includes("article mobile")||t.includes("mobile responsive")) return "Mobile Responsiveness";
  if(t.includes("advertis")||t.includes("billboard")||t.includes("gpt ad")) return "Advertising";
  if(t.includes("takeover")||t.includes("builder.io")||t.includes("marketing page")||t.includes("marketing landing")||t.includes("marketing")) return "Marketing";
  if(t.includes("registration")||t.includes("sign up")||t.includes("sign-up")||t.includes("login")) return "Registrations";
  if(t.includes("data ribbon")||t.includes("ui design upgrade")||t.includes("watchlist")||t.includes("homepage")) return "Homepage";
  if(t.includes("seo")||t.includes("semantic markup")||t.includes("search engine")||t.includes("hsts")||t.includes("canonical")||t.includes("metadata")||t.includes("sitemap")) return "SEO / Platform";
  if(t.includes("paywall")||t.includes("content mask")) return "Paywall";
  if(t.includes("article template")||t.includes("investor data")||t.includes("editorial")||t.includes("author")||t.includes("standfirst")||t.includes("pull quote")||t.includes("block quote")||t.includes("listing")) return "Editorial";
  if(t.includes("analytics")||t.includes("tracking")||t.includes("ga4")||t.includes("gtm")||t.includes("heap")||t.includes("datalayer")) return "Analytics / Tracking";
  if(t.includes("request a demo")||t.includes("demo request")||t.includes("request demo")||t.includes("demo")) return "Request a Demo";
  if(t.includes("header")||t.includes("footer")||t.includes("navigation")||t.includes("nav ")||t.includes("breadcrumb")) return "Navigation / UX";
  if(t.includes("tech debt")||t.includes("deals")||t.includes("data room")||t.includes("database")) return "Data Room";
  if(t.includes("sponsored")||t.includes("thought leadership")||t.includes("sponsor")) return "Sponsored Content";
  if(t.includes("bug")||t.includes("fix")||t.includes("issue")||t.includes("error")||t.includes("broken")||t.includes("not appear")) return "Bugs";
  if(t.includes("zephr")||t.includes("platform")||t.includes("infrastructure")||t.includes("logging")||t.includes("sso")||t.includes("s3")||t.includes("wordpress")||t.includes("lazy load")||t.includes("network")) return "Platform";
  return "Platform";
}

/* ═══════════════════════════════════════════════════════════════════════
   PARSE + NORMALISE — one layer, two sources (CSV primary fallback,
   connector/JSON primary). Both produce "records" → normaliseTickets().
   Robust: extra columns ignored, missing columns degrade, never crash.
   ═══════════════════════════════════════════════════════════════════════ */
function parseCSV(t){
  const r=[]; let i=0,n=t.length;
  while(i<n){
    const row=[]; let inRow=true;
    while(i<n&&inRow){
      if(t[i]==='"'){
        i++; let v="";
        while(i<n){
          if(t[i]==='"'&&t[i+1]==='"'){v+='"';i+=2;}
          else if(t[i]==='"'){i++;break;}
          else v+=t[i++];
        }
        row.push(v);
        if(t[i]===',')i++;else inRow=false;
      }else{
        let s=i;
        while(i<n&&t[i]!==','&&t[i]!=='\n'&&t[i]!=='\r')i++;
        row.push(t.slice(s,i).trim());
        if(t[i]===',')i++;else inRow=false;
      }
    }
    while(i<n&&(t[i]==='\r'||t[i]==='\n'))i++;
    if(row.length>0&&!(row.length===1&&row[0]===''))r.push(row);
  }
  return r;
}

// CSV rows → generic records {id,title,status,parentSummary,sprint,points,team,desc,priority}
function csvToRecords(csvText){
  const p=parseCSV(csvText);
  if(p.length<2) return [];
  const hd=p[0].map(h=>h.replace(/^﻿/,"").toLowerCase().trim());
  const idxOf=name=>hd.indexOf(name);
  const firstOf=names=>names.reduce((f,n)=>f>=0?f:hd.indexOf(n),-1);
  const allIdxOf=name=>hd.reduce((a,h,i)=>h===name?[...a,i]:a,[]);
  const iKey=firstOf(["issue key","key","id"]);
  const iSummary=firstOf(["summary","title"]);
  const iStatus=firstOf(["status"]);
  const iParent=firstOf(["parent summary","epic name","epic link summary","parent"]);
  const iPoints=firstOf(["custom field (story points)","story points","story point estimate","points"]);
  const iTeam=firstOf(["custom field (engineering team)","engineering team","custom field (team)","team"]);
  const iDesc=firstOf(["description","desc"]);
  const iPriority=firstOf(["priority"]);
  const sprintIdxs=allIdxOf("sprint").length?allIdxOf("sprint"):[firstOf(["sprint"])].filter(x=>x>=0);
  if(iKey<0||iSummary<0) return [];
  const get=(row,idx)=>idx>=0&&idx<row.length?(row[idx]||"").trim():"";
  const records=[];
  for(const row of p.slice(1)){
    if(!row.length) continue;
    const id=get(row,iKey); if(!id) continue;
    // highest sprint across all sprint columns
    let sprintVal="TBD";
    for(const si of sprintIdxs){
      const sv=get(row,si).replace(/\s+/g," "); if(!sv) continue;
      const ns=normaliseSprint(sv);
      if(ns!=="TBD"){ if(sprintVal==="TBD"||sprintNumOf(ns)>sprintNumOf(sprintVal)) sprintVal=ns; }
    }
    records.push({
      id, title:get(row,iSummary), status:get(row,iStatus),
      parentSummary:get(row,iParent), sprint:sprintVal,
      points:get(row,iPoints), team:get(row,iTeam),
      desc:get(row,iDesc), priority:get(row,iPriority)
    });
  }
  return records;
}

// Connector / JSON → records. Accepts our simplified shape OR raw Atlassian issues.
function jsonToRecords(input){
  let data=input;
  if(typeof input==="string"){ try{ data=JSON.parse(input); }catch(e){ return []; } }
  const arr=Array.isArray(data)?data:(data&&Array.isArray(data.issues)?data.issues:(data&&Array.isArray(data.rows)?data.rows:[]));
  const adfText=node=>{ // best-effort Atlassian Document Format → plain text
    if(!node) return ""; if(typeof node==="string") return node;
    if(node.text) return node.text;
    if(Array.isArray(node.content)) return node.content.map(adfText).join(node.type==="paragraph"?"\n":" ");
    return "";
  };
  return arr.map(it=>{
    const f=it.fields||it;
    const sprintRaw=f.sprint||f.Sprint||(Array.isArray(f.sprints)?f.sprints.map(s=>s.name||s).join(" "):"")||
      (Array.isArray(f.customfield_10020)?f.customfield_10020.map(s=>(s&&s.name)||s).join(" "):"");
    return {
      id:it.key||it.id||f.key||f.id||"",
      title:f.summary||f.title||"",
      status:(f.status&&(f.status.name||f.status))||f.Status||"",
      parentSummary:(f.parent&&f.parent.fields&&f.parent.fields.summary)||f.parentSummary||f["parent summary"]||f.epic||"",
      sprint:normaliseSprint(sprintRaw||f.sprint||""),
      points:f.points!=null?f.points:(f.storyPoints!=null?f.storyPoints:(f.customfield_10016!=null?f.customfield_10016:"")),
      team:f.team||f.engineeringTeam||f["engineering team"]||(f.customfield_team)||"",
      desc:typeof f.description==="string"?f.description:adfText(f.description)||f.desc||"",
      priority:(f.priority&&(f.priority.name||f.priority))||f.Priority||""
    };
  }).filter(r=>r.id);
}

// Map a record's raw priority → our state, honouring per-team unlock + config map
function resolvePriority(rec, team, existingPriority){
  const teamUnlocked=!CFG.protectPriority||(CFG.priorityMapTeams||[]).includes(team);
  if(teamUnlocked && rec.priority){
    const mapped=CFG.priorityMap[rec.priority]||CFG.priorityMap[String(rec.priority).trim()];
    if(mapped) return mapped;
    // already in our format?
    if(PRIORITY_OPTS.includes(rec.priority)) return rec.priority;
  }
  return existingPriority||defaultPriority();
}

/* normaliseTickets — the single normalisation layer.
   records: generic shape from csvToRecords / jsonToRecords
   existing: current rows (with _id, desc, notes, overrides)
   source treated as source-of-truth: records present = upsert, absent = removed. */
function normaliseTickets(records, existing, opts={}){
  if(!records||records.length===0) return {rows:existing||[],added:0,updated:0,removed:0,discoveredTeams:[]};
  const existingMap=Object.fromEntries((existing||[]).map(r=>[r.id,r]));
  const ids=new Set(); const discovered=new Set(); const out=[];
  let added=0,updated=0;
  for(const rec of records){
    const id=rec.id; if(!id) continue; ids.add(id);
    const summary=rec.title||"";
    const status=STATUS_MAP[(rec.status||"").toLowerCase()]||rec.status||"To Do";
    const team=mapTeamFromRaw(rec.team)||"";
    if(team) discovered.add(team);
    const inferredTheme=inferTheme(rec.parentSummary,summary);
    const hasThemeSignal=inferredTheme&&inferredTheme!=="Uncategorised";
    const rawPts=rec.points;
    const pts=(rawPts===""||rawPts==null||rawPts==="-")?null:(isNaN(parseFloat(rawPts))?null:Math.round(parseFloat(rawPts)));
    const cleanDesc=(rec.desc||"").trim();
    const ex=existingMap[id];
    if(ex){
      out.push({
        ...ex,
        title:summary||ex.title,
        status,
        sprint:rec.sprint||ex.sprint,
        team:team||ex.team,
        // keep manual override; else use a real inferred theme; else preserve existing
        // (so a lightweight connector refresh without epic data won't blank themes)
        theme:ex._themeOverride?ex.theme:(hasThemeSignal?inferredTheme:(ex.theme||inferredTheme)),
        points:pts,
        // desc: never strip. Keep user-edited desc; else take fresh import; else keep prior.
        desc: ex._descOverride ? ex.desc : (cleanDesc || ex.desc || ""),
        // priority: protected unless this team is unlocked AND Jira sent a value
        priority: resolvePriority(rec, team||ex.team, ex.priority)
      });
      updated++;
    }else{
      out.push({
        _id:Date.now()+Math.random(),
        id, team,
        title:summary||"(Untitled)",
        desc:cleanDesc,
        theme:inferredTheme||"Uncategorised",
        priority:resolvePriority(rec, team, defaultPriority()),
        sprint:rec.sprint||"TBD",
        points:pts, status, notes:""
      });
      added++;
    }
  }
  if(opts.upsertOnly){
    // keep existing tickets that weren't in this (partial) import — don't remove them
    const kept=(existing||[]).filter(r=>!ids.has(r.id));
    return {rows:[...out,...kept],added,updated,removed:0,discoveredTeams:[...discovered]};
  }
  const removed=(existing||[]).filter(r=>!ids.has(r.id)).length;
  return {rows:out,added,updated,removed,discoveredTeams:[...discovered]};
}

/* ═══════════════════════════════════════════════════════════════════════
   AI SUMMARIES — live, cached. stripJira() cleans markup; we fetch the
   Anthropic messages API; on any failure we fall back to the heuristic
   condense() so the table never blocks or breaks.
   ═══════════════════════════════════════════════════════════════════════ */
function stripJira(s){
  if(!s) return "";
  return s
    .replace(/\{panel[^}]*\}/g,"")
    .replace(/\{color[^}]*\}(.*?)\{color\}/gs,"$1")
    .replace(/\{[^}]+\}/g,"")
    .replace(/!\S+\|[^!]+!/g,"")
    .replace(/\[([^|\]]+)\|[^\]]+\]/g,"$1")
    .replace(/\[\^[^\]]+\]/g,"")
    .replace(/^[*#]+\s*/gm,"")
    .replace(/\*([^*]+)\*/g,"$1")
    .replace(/_(.*?)_/g,"$1")
    .replace(/\+([^+]+)\+/g,"$1")
    .replace(/h[1-6]\./g,"")
    .replace(/\|\|/g," ").replace(/\|/g," ")
    .replace(/\n{3,}/g,"\n\n")
    .replace(/^\s+/gm,"")
    .replace(/^description[:\s]*/i,"")
    .replace(/^background[:\s]*/i,"")
    .trim();
}
// Are we inside the Claude artifact runtime? (window.claude.complete exists there.)
// Used to hide the dev/hosted-only "Refresh from Jira" button — in an artifact you
// refresh via Import (and shared storage propagates it to everyone).
function isArtifactRuntime(){ return typeof window!=="undefined"&&window.claude&&typeof window.claude.complete==="function"; }
// stable, fast string hash → cache invalidation key
function hashStr(s){ let h=0; const str=String(s||""); for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))|0; } return String(h>>>0); }

// Heuristic fallback (OBX condense, trimmed): builds a business-context sentence
function condense(t){
  const raw=stripJira((t.desc||"").trim());
  const title=(t.title||"").trim();
  const notes=(t.notes||"").trim();
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
  const titleWords=new Set(norm(title).split(" ").filter(w=>w.length>3));
  const descWords=norm(raw).split(" ").filter(w=>w.length>3);
  const overlap=descWords.filter(w=>titleWords.has(w)).length;
  const redundant=raw.length<6||(descWords.length>0&&overlap/descWords.length>0.6)||norm(raw)===norm(title);
  if(!redundant&&raw.length>20){
    const sentences=raw.match(/[^.!?]+[.!?]+/g)||[raw];
    const meaningful=sentences.filter(s=>s.trim().length>15);
    const base=meaningful.slice(0,3).join(" ").trim();
    const finalBase=base.length>20?base:(raw.split(/\s+/).slice(0,55).join(" ")+(raw.split(/\s+/).length>55?"…":""));
    if(notes&&notes.length>4&&norm(notes)!==norm(raw)&&norm(notes)!==norm(title)) return finalBase+" — "+notes;
    return finalBase;
  }
  const prio=t.priority===topPriority()?"Top priority — required for the upcoming milestone."
    :t.priority===secondPriority()?"High-priority delivery for this cycle.":"Planned improvement for this cycle.";
  const statusS=t.status==="Blocked"?" Currently blocked — dependency resolution required."
    :t.status==="In Testing"?" In testing and validation."
    :DONE_STATUSES.has(t.status)?" Delivered.":"";
  return "Part of the "+(t.theme||"Uncategorised")+" workstream. "+prio+statusS;
}

// Fetch one AI summary (≤2 sentences). Returns string or throws.
// Works in both the Claude artifact runtime (window.claude.complete) and a
// hosted/dev build (Anthropic messages API). Falls back to the heuristic on any error.
async function fetchAISummary(t){
  const src=stripJira(t.desc||"").slice(0,4000);
  const prompt="You are summarising a Jira ticket for a delivery roadmap. In 1–2 short, plain-English sentences, describe what is being built and why it matters. No preamble, no markdown, no quotes.\n\nTitle: "+(t.title||"")+"\nTheme: "+(t.theme||"")+"\nStatus: "+(t.status||"")+"\nDescription:\n"+(src||"(no description)");
  // Claude artifact runtime
  if(typeof window!=="undefined"&&window.claude&&typeof window.claude.complete==="function"){
    const txt=(await window.claude.complete(prompt)||"").trim();
    if(txt) return txt;
    throw new Error("empty");
  }
  // hosted / dev: Anthropic messages API
  const resp=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","anthropic-version":"2023-06-01"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:prompt}]})
  });
  if(!resp.ok) throw new Error("AI "+resp.status);
  const data=await resp.json();
  const text=(data&&data.content&&data.content[0]&&data.content[0].text||"").trim();
  if(!text) throw new Error("empty");
  return text;
}

/* ═══════════════════════════════════════════════════════════════════════
   EXPORT / SORT / DUPLICATES
   ═══════════════════════════════════════════════════════════════════════ */
function exportToCSV(rows){
  const ts=new Date().toLocaleDateString("en-GB").replace(/\//g,"-");
  const esc=v=>{const s=String(v??"");return(s.includes(",")||s.includes('"')||s.includes("\n"))?'"'+s.replace(/"/g,'""')+'"':s;};
  const lines=["Team,ID,Theme,Title,Priority,Sprint,Points,Status,Notes,Description",
    ...rows.map(r=>[teamLabel(r.team)||"",r.id,r.theme||"",r.title,
      (r.priority||"").replace(/[🔴🟠🟡🟢]/g,"").trim(),
      r.sprint,r.points??"",r.status||"",r.notes??"",r.desc??""].map(esc).join(","))];
  const b64=btoa(unescape(encodeURIComponent(lines.join("\r\n"))));
  const a=document.createElement("a");a.href="data:text/csv;base64,"+b64;
  a.download=(CFG.projectName||"Roadmap").replace(/\s+/g,"-")+"-Backlog-"+ts+".csv";
  document.body.appendChild(a);a.click();document.body.removeChild(a);
}
function sortRows(rows,col,dir,sprintOpts){
  if(!col) return rows;
  return [...rows].sort((a,b)=>{
    let va=a[col],vb=b[col],cmp=0;
    if(col==="points"){va=va==null?-1:va;vb=vb==null?-1:vb;cmp=va-vb;}
    else if(col==="priority") cmp=(PRIORITY_ORDER[va]??9)-(PRIORITY_ORDER[vb]??9);
    else if(col==="sprint") cmp=sprintOpts.indexOf(va)-sprintOpts.indexOf(vb);
    else cmp=(va||"").localeCompare(vb||"");
    return dir==="asc"?cmp:-cmp;
  });
}
const STOP_WORDS=new Set(["the","and","for","with","from","this","that","page"]);
function tokenise(s){return(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=3&&!STOP_WORDS.has(w));}
function similarity(a,b){
  const ta=new Set(tokenise(a)),tb=new Set(tokenise(b));
  if(!ta.size||!tb.size) return 0;
  let o=0;ta.forEach(t=>{if(tb.has(t))o++;});
  return o/Math.max(ta.size,tb.size);
}
function findDuplicates(rows){
  const all=rows.filter(r=>!DONE_STATUSES.has(r.status));
  const pairs=[],seen=new Set();
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
    const a=all[i],b=all[j];
    if(a.id===b.id) continue;
    const key=a._id+"-"+b._id;
    if(seen.has(key)) continue; seen.add(key);
    const score=Math.max(similarity(a.title,b.title),similarity(a.desc||"",b.desc||"")*0.8);
    if(score>=0.5) pairs.push({a,b,score});
  }
  return pairs.sort((x,y)=>y.score-x.score).slice(0,50);
}
// "primary" ticket = the one whose id starts with the configured key prefix
function pickPrimary(tickets){
  const pref=(CFG.keyPrefix||"").toUpperCase();
  if(pref){ const p=tickets.find(t=>String(t.id||"").toUpperCase().startsWith(pref)); if(p) return p; }
  return tickets[0];
}

/* ═══════════════════════════════════════════════════════════════════════
   UI ATOMS
   ═══════════════════════════════════════════════════════════════════════ */
function Tip({text,children}){
  const[show,setShow]=useState(false);
  return(
    <span style={{position:"relative",display:"inline-flex",alignItems:"center"}}
      onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      {children}
      {show&&(
        <div style={{position:"absolute",bottom:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",background:"#0f172a",border:"1px solid #334155",borderRadius:6,padding:"5px 9px",fontSize:10,color:"#e2e8f0",whiteSpace:"nowrap",zIndex:2000,boxShadow:"0 4px 12px rgba(0,0,0,0.5)",pointerEvents:"none",lineHeight:1.5}}>
          {text}
          <div style={{position:"absolute",top:"100%",left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"5px solid transparent",borderRight:"5px solid transparent",borderTop:"5px solid #334155"}}/>
        </div>
      )}
    </span>
  );
}
function Overlay({children,wide}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#1e293b",borderRadius:12,padding:24,maxWidth:wide?920:460,width:"100%",border:"1px solid #334155",boxShadow:"0 20px 60px rgba(0,0,0,0.6)",maxHeight:"92vh",overflowY:"auto"}}>
        {children}
      </div>
    </div>
  );
}
function Toast({msg,onClose}){
  useEffect(()=>{const t=setTimeout(onClose,5000);return()=>clearTimeout(t);},[onClose]);
  return(
    <div style={{position:"fixed",bottom:24,right:24,background:"#14532d",border:"1px solid #166534",borderRadius:10,padding:"12px 20px",color:"#f1f5f9",fontSize:13,zIndex:2000,display:"flex",alignItems:"center",gap:12,maxWidth:480}}>
      <span>✅</span><div>{msg}</div>
      <button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",marginLeft:8}}>✕</button>
    </div>
  );
}
function JiraLink({id}){
  const base=(CFG.jiraBaseUrl||"").replace(/\/$/,"");
  const style={fontSize:10,fontFamily:"monospace",color:"#60a5fa",background:"rgba(96,165,250,0.1)",padding:"0 5px",borderRadius:3,textDecoration:"none",whiteSpace:"nowrap"};
  if(!base) return <span style={style}>{id}</span>;
  return <a href={base+"/browse/"+id} target="_blank" rel="noreferrer" style={style}
    onMouseEnter={e=>e.currentTarget.style.background="rgba(96,165,250,0.25)"}
    onMouseLeave={e=>{e.currentTarget.style.background="rgba(96,165,250,0.1)";}}>{id} ↗</a>;
}
function EditCell({value,onChange,mono}){
  const[editing,setEditing]=useState(false);
  const[v,setV]=useState(value);
  const ref=useRef();
  useEffect(()=>{if(editing&&ref.current)ref.current.focus();},[editing]);
  const commit=()=>{setEditing(false);onChange(v);};
  const textColor=mono?"#60a5fa":"inherit";
  const fontFam=mono?"monospace":"inherit";
  const fSize=mono?11:12;
  if(editing){
    return(
      <textarea ref={ref} value={v!=null?v:""}
        onChange={e=>setV(e.target.value)} onBlur={commit}
        onKeyDown={e=>{if(e.key==="Escape"){setV(value);setEditing(false);}}}
        style={{width:"100%",minHeight:44,background:"#0f172a",color:"#f1f5f9",border:"1px solid #3b82f6",borderRadius:4,padding:"4px 6px",fontSize:fSize,fontFamily:fontFam,resize:"vertical",outline:"none"}}/>
    );
  }
  return(
    <div onClick={()=>{setV(value);setEditing(true);}}
      style={{cursor:"text",padding:"2px 4px",borderRadius:4,minHeight:18,lineHeight:1.4,color:textColor,fontFamily:fontFam,fontSize:fSize,border:"1px solid transparent"}}
      onMouseEnter={e=>e.currentTarget.style.borderColor="#334155"}
      onMouseLeave={e=>{e.currentTarget.style.borderColor="transparent";}}>
      {(value!==null&&value!==undefined&&value!=="")?value:<span style={{color:"#334155",fontStyle:"italic"}}>—</span>}
    </div>
  );
}
function PillSelect({value,opts,onChange,colorMap,getColor,labelFn}){
  const[open,setOpen]=useState(false);
  const ref=useRef();
  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);
  const col=getColor?getColor(value):(colorMap?colorMap[value]:null);
  const trigBg=col?col+"33":"#0f172a";
  const trigBorder=col?"1px solid "+col+"55":"1px solid #334155";
  const lbl=labelFn||(x=>x);
  return(
    <div ref={ref} style={{position:"relative"}}>
      <div onClick={()=>setOpen(o=>!o)}
        style={{cursor:"pointer",padding:"2px 7px",borderRadius:4,fontSize:10,fontWeight:700,background:trigBg,color:"#f1f5f9",border:trigBorder,display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}>
        {col&&<span style={{width:6,height:6,borderRadius:"50%",background:col,flexShrink:0}}/>}
        <span>{lbl(value)}</span>
        <span style={{fontSize:8,opacity:0.5}}>▼</span>
      </div>
      {open&&(
        <div style={{position:"absolute",top:"100%",left:0,zIndex:999,background:"#0f172a",border:"1px solid #334155",borderRadius:6,marginTop:2,minWidth:140,boxShadow:"0 8px 24px rgba(0,0,0,0.6)",maxHeight:240,overflowY:"auto"}}>
          {opts.map(o=>{
            const c=getColor?getColor(o):(colorMap?colorMap[o]:null);
            const itemBg=o===value?"#1e293b":"transparent";
            return(
              <div key={o} onClick={()=>{onChange(o);setOpen(false);}}
                style={{padding:"5px 10px",cursor:"pointer",fontSize:11,fontWeight:600,color:"#f1f5f9",background:itemBg,display:"flex",alignItems:"center",gap:6}}
                onMouseEnter={e=>e.currentTarget.style.background="#1e293b"}
                onMouseLeave={e=>{e.currentTarget.style.background=itemBg;}}>
                {c&&<span style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0}}/>}
                {lbl(o)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function StatusDot({value,onChange}){
  const[open,setOpen]=useState(false);
  const ref=useRef();
  const col=STATUS_COL[value]||"#64748b";
  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);
  return(
    <div ref={ref} style={{position:"relative"}}>
      <div onClick={()=>setOpen(o=>!o)}
        style={{cursor:"pointer",padding:"2px 7px",borderRadius:4,fontSize:10,fontWeight:600,background:col+"22",color:col,border:"1px solid "+col+"44",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap",minWidth:90}}>
        <span style={{width:6,height:6,borderRadius:"50%",background:col,flexShrink:0}}/>
        <span style={{flex:1}}>{value||"To Do"}</span>
        <span style={{fontSize:8,opacity:0.5}}>▼</span>
      </div>
      {open&&(
        <div style={{position:"absolute",top:"100%",left:0,zIndex:999,background:"#0f172a",border:"1px solid #334155",borderRadius:6,marginTop:2,minWidth:175,boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}}>
          {STATUS_OPTS.map(s=>{
            const c=STATUS_COL[s]||"#64748b";
            const sBg=s===value?"#1e293b":"transparent";
            return(
              <div key={s} onClick={()=>{onChange(s);setOpen(false);}}
                style={{padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:600,color:c,background:sBg,display:"flex",alignItems:"center",gap:7}}
                onMouseEnter={e=>e.currentTarget.style.background="#1e293b"}
                onMouseLeave={e=>{e.currentTarget.style.background=sBg;}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0}}/>{s}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function ThemeSelect({value,opts,onChange,colorMap,onNewTheme,onRemoveTheme}){
  const[open,setOpen]=useState(false);
  const[adding,setAdding]=useState(false);
  const[confirmDel,setConfirmDel]=useState(null);
  const[delText,setDelText]=useState("");
  const[name,setName]=useState("");
  const[color,setColor]=useState(THEME_PALETTE[0]);
  const ref=useRef();const iRef=useRef();const delRef=useRef();
  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target)){setOpen(false);setAdding(false);setName("");setConfirmDel(null);setDelText("");}};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);
  useEffect(()=>{if(adding&&iRef.current)iRef.current.focus();},[adding]);
  useEffect(()=>{if(confirmDel&&delRef.current)delRef.current.focus();},[confirmDel]);
  const col=colorMap[value];
  const commit=()=>{const n=name.trim();if(!n)return;onNewTheme(n,color);onChange(n);setOpen(false);setAdding(false);setName("");setColor(THEME_PALETTE[0]);};
  const doDelete=o=>{onRemoveTheme(o);setConfirmDel(null);setDelText("");if(value===o)onChange(opts.find(x=>x!==o)||"Uncategorised");};
  return(
    <div ref={ref} style={{position:"relative"}}>
      <div onClick={()=>setOpen(o=>!o)}
        style={{cursor:"pointer",padding:"2px 7px",borderRadius:4,fontSize:10,fontWeight:600,background:col?col+"33":"#0f172a",color:"#f1f5f9",border:col?"1px solid "+col+"55":"1px solid #334155",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:col||"#475569",flexShrink:0}}/>
        <span style={{flex:1}}>{value}</span>
        <span style={{fontSize:8,opacity:0.5}}>▼</span>
      </div>
      {open&&(
        <div style={{position:"absolute",top:"100%",left:0,zIndex:999,background:"#0f172a",border:"1px solid #334155",borderRadius:6,marginTop:2,minWidth:220,boxShadow:"0 8px 24px rgba(0,0,0,0.6)",maxHeight:320,overflowY:"auto"}}>
          {opts.map(o=>{
            const c=colorMap[o];
            const isConfirm=confirmDel===o;
            const rowBg=o===value?"#1e293b":"transparent";
            return(
              <div key={o}>
                {!isConfirm&&(
                  <div style={{display:"flex",alignItems:"center",background:rowBg}}
                    onMouseEnter={e=>e.currentTarget.style.background="#1e293b"}
                    onMouseLeave={e=>{e.currentTarget.style.background=rowBg;}}>
                    <div onClick={()=>{onChange(o);setOpen(false);setConfirmDel(null);setDelText("");}}
                      style={{flex:1,padding:"5px 10px",cursor:"pointer",fontSize:11,fontWeight:600,color:"#f1f5f9",display:"flex",alignItems:"center",gap:6}}>
                      {c&&<span style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0}}/>}{o}
                    </div>
                    <div onClick={e=>{e.stopPropagation();setConfirmDel(o);setDelText("");}}
                      style={{padding:"4px 8px",cursor:"pointer",color:"#ef4444",fontSize:11,fontWeight:700,background:"rgba(239,68,68,0.1)",borderRadius:3,margin:"2px 6px 2px 0",border:"1px solid rgba(239,68,68,0.3)"}}>✕</div>
                  </div>
                )}
                {isConfirm&&(
                  <div style={{padding:"8px 10px",background:"rgba(69,10,10,0.4)",borderLeft:"2px solid #ef4444"}} onClick={e=>e.stopPropagation()}>
                    <div style={{fontSize:10,color:"#f87171",marginBottom:5}}>Type <strong>delete</strong> to remove</div>
                    <input ref={delRef} value={delText} onChange={e=>setDelText(e.target.value)}
                      onKeyDown={e=>{if(e.key==="Enter"&&delText==="delete")doDelete(o);if(e.key==="Escape"){setConfirmDel(null);setDelText("");}}}
                      placeholder="delete"
                      style={{width:"100%",background:"#0f172a",color:"#f1f5f9",border:"1px solid "+(delText==="delete"?"#ef4444":"#334155"),borderRadius:4,padding:"4px 7px",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:6}}/>
                    <div style={{display:"flex",gap:5}}>
                      <button onClick={()=>{setConfirmDel(null);setDelText("");}} style={{flex:1,padding:"3px 0",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:4,cursor:"pointer",fontSize:10}}>Cancel</button>
                      <button onClick={()=>{if(delText==="delete")doDelete(o);}} disabled={delText!=="delete"} style={{flex:1,padding:"3px 0",background:delText==="delete"?"#dc2626":"#334155",color:delText==="delete"?"#fff":"#64748b",border:"none",borderRadius:4,cursor:delText==="delete"?"pointer":"not-allowed",fontSize:10,fontWeight:600}}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!adding&&(
            <div onClick={()=>setAdding(true)}
              style={{padding:"6px 10px",cursor:"pointer",fontSize:11,color:"#60a5fa",borderTop:"1px solid #1e293b"}}
              onMouseEnter={e=>e.currentTarget.style.background="#1e293b"}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
              + New theme
            </div>
          )}
          {adding&&(
            <div style={{padding:"10px"}} onClick={e=>e.stopPropagation()}>
              <input ref={iRef} value={name} onChange={e=>setName(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")commit();if(e.key==="Escape"){setAdding(false);setName("");}}}
                placeholder="Theme name"
                style={{width:"100%",background:"#1e293b",color:"#f1f5f9",border:"1px solid #334155",borderRadius:4,padding:"4px 7px",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                {THEME_PALETTE.map(c=>(
                  <div key={c} onClick={()=>setColor(c)}
                    style={{width:16,height:16,borderRadius:3,background:c,cursor:"pointer",border:color===c?"2px solid #fff":"2px solid transparent"}}/>
                ))}
              </div>
              <div style={{display:"flex",gap:5}}>
                <button onClick={()=>{setAdding(false);setName("");}} style={{flex:1,padding:"4px 0",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:4,cursor:"pointer",fontSize:10}}>Cancel</button>
                <button onClick={commit} disabled={!name.trim()} style={{flex:1,padding:"4px 0",background:name.trim()?"#1d4ed8":"#334155",color:name.trim()?"#fff":"#64748b",border:"none",borderRadius:4,cursor:name.trim()?"pointer":"not-allowed",fontSize:10,fontWeight:600}}>Add</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   SPRINT OVERVIEW (per-team capacity bars)
   ═══════════════════════════════════════════════════════════════════════ */
function SprintOverview({rows,teamCapacity,onTeamCapChange,visibleSprints,activeTeams}){
  const[barsOpen,setBarsOpen]=useState(true);
  const DEF=CFG.defaultTeamCap||36;
  const sprintPts=(s,team)=>rows.filter(r=>r.sprint===s&&(!team||r.team===team)&&!DONE_STATUSES.has(r.status)).reduce((a,r)=>a+(r.points||0),0);
  const tbdCount=(s,team)=>rows.filter(r=>r.sprint===s&&(!team||r.team===team)&&r.points===null&&!DONE_STATUSES.has(r.status)).length;
  const getTeamCap=(s,t)=>teamCapacity[s+":"+t]||DEF;
  const getCapacity=(s)=>{
    const teamsIn=[...new Set(rows.filter(r=>r.sprint===s&&!DONE_STATUSES.has(r.status)).map(r=>r.team).filter(Boolean))];
    return teamsIn.reduce((a,t)=>a+getTeamCap(s,t),0)||DEF;
  };
  const totalPtsLeft=rows.filter(r=>!DONE_STATUSES.has(r.status)).reduce((a,r)=>a+(r.points||0),0);
  const totalTbd=rows.filter(r=>!DONE_STATUSES.has(r.status)&&r.points===null).length;
  const avgCap=(activeTeams.filter(t=>t!=="All").length*DEF)||(DEF*3);
  const sprintsLeft=(totalPtsLeft/avgCap).toFixed(1);

  function TeamCapChip({sprint,team,col}){
    const[editing,setEditing]=useState(false);
    const[v,setV]=useState(String(getTeamCap(sprint,team)));
    const ref=useRef();
    useEffect(()=>{if(editing&&ref.current){ref.current.focus();ref.current.select();}},[editing]);
    const cap=getTeamCap(sprint,team);
    const commit=()=>{const n=parseInt(v);if(!isNaN(n)&&n>0)onTeamCapChange(sprint,team,n);else setV(String(cap));setEditing(false);};
    const isCustom=!!teamCapacity[sprint+":"+team]&&teamCapacity[sprint+":"+team]!==DEF;
    if(editing) return(
      <input ref={ref} type="number" min={1} max={999} value={v} onChange={e=>setV(e.target.value)} onBlur={commit}
        onKeyDown={e=>{if(e.key==="Enter")commit();if(e.key==="Escape"){setV(String(cap));setEditing(false);}}}
        style={{width:30,background:"#0f172a",border:"1px solid "+col,borderRadius:3,color:col,fontWeight:700,fontSize:9,padding:"0 2px",textAlign:"center",outline:"none"}}/>
    );
    return(
      <Tip text={"Capacity: "+cap+"pts. Click to edit. Default "+DEF+"pts/sprint."}>
        <span onClick={e=>{e.stopPropagation();setV(String(cap));setEditing(true);}}
          style={{fontSize:9,color:isCustom?"#f1f5f9":"#64748b",cursor:"pointer",borderBottom:"1px dashed "+(isCustom?"#475569":"#334155"),lineHeight:1.2}}>/{cap}</span>
      </Tip>
    );
  }
  return(
    <div style={{marginBottom:16}}>
      <div onClick={()=>setBarsOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:6,marginBottom:barsOpen?8:0,cursor:"pointer",userSelect:"none"}}>
        <span style={{fontSize:10,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>Sprint Capacity</span>
        <span style={{fontSize:11,color:"#64748b",marginLeft:4}}>
          {"— "}<span style={{color:"#c4b5fd",fontWeight:700}}>{sprintsLeft} sprints</span>
          <span style={{color:"#94a3b8"}}>{" to clear backlog @ "+avgCap+"pts avg · "}</span>
          <span style={{color:"#fbbf24",fontWeight:700}}>+{totalTbd} TBD</span>
        </span>
        <span style={{fontSize:11,color:"#475569",marginLeft:"auto"}}>{barsOpen?"▲":"▼"}</span>
      </div>
      {barsOpen&&(
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {visibleSprints.map(s=>{
            const n=sprintNumOf(s);
            const p=sprintPts(s,null);const c=getCapacity(s);const over=p>c;
            const pct=Math.min((p/c)*100,100);const col=sprintCol(n);const act=isActive(n);
            const teamsInSprint=activeTeams.filter(t=>t!=="All"&&rows.some(r=>r.sprint===s&&r.team===t&&!DONE_STATUSES.has(r.status)));
            return(
              <div key={s} style={{background:"#1e293b",borderRadius:8,padding:"10px 14px",flex:1,minWidth:140,borderLeft:"3px solid "+col}}>
                <div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:3,display:"flex",alignItems:"center",gap:5}}>
                  {s}
                  {act&&<span style={{fontSize:9,background:col+"33",color:col,padding:"1px 5px",borderRadius:3,fontWeight:700}}>ACTIVE</span>}
                  <span style={{marginLeft:"auto",fontSize:9,color:"#475569",fontWeight:400,textTransform:"none",letterSpacing:0,display:"flex",alignItems:"center",gap:3}}>
                    📅 <span style={{color:"#64748b"}}>End</span> <span style={{color:col,fontWeight:600}}>{fmtDate(sprintEndDate(n))}</span>
                  </span>
                </div>
                <div style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:4}}>
                  <span style={{fontSize:18,fontWeight:700,color:over?"#ef4444":"#f1f5f9"}}>{p}</span>
                  <span style={{fontSize:11,color:"#475569"}}>{"/ "+c}</span>
                  {tbdCount(s,null)>0&&<Tip text="Tickets without estimates"><span style={{fontSize:10,color:"#f59e0b",cursor:"default"}}>+{tbdCount(s,null)} TBD</span></Tip>}
                </div>
                <div style={{height:3,background:"#0f172a",borderRadius:2,overflow:"hidden",marginBottom:8}}>
                  <div style={{height:"100%",width:pct+"%",background:over?"#ef4444":col,borderRadius:2,transition:"width 0.3s"}}/>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {teamsInSprint.map(t=>{
                    const tc=teamColor(t);const tPts=sprintPts(s,t);const tTbd=tbdCount(s,t);const tCap=getTeamCap(s,t);
                    return(
                      <div key={t}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
                          <span style={{fontSize:9,fontWeight:700,color:tc,background:tc+"22",padding:"1px 6px",borderRadius:3,border:"1px solid "+tc+"44"}}>{teamLabel(t)}</span>
                          <div style={{display:"flex",alignItems:"center",gap:3}}>
                            <span style={{fontSize:11,fontWeight:700,color:tPts>tCap?"#ef4444":"#f1f5f9"}}>
                              {tPts}{tTbd>0&&<span style={{fontSize:9,color:"#f59e0b",fontWeight:400,marginLeft:2}}>+{tTbd}</span>}
                            </span>
                            <TeamCapChip sprint={s} team={t} col={tc}/>
                            <span style={{fontSize:9,color:"#475569"}}>pts</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {teamsInSprint.length===0&&<div style={{fontSize:9,color:"#334155"}}>No tickets</div>}
                </div>
                <div style={{fontSize:9,color:over?"#ef4444":"#475569",marginTop:6}}>{over?"Over by "+(p-c)+"pts":(c-p)+" left"}</div>
              </div>
            );
          })}
          {rows.some(r=>r.sprint==="TBD"&&!DONE_STATUSES.has(r.status))&&(
            <div style={{background:"#1e293b",borderRadius:8,padding:"10px 14px",flex:1,minWidth:100,borderLeft:"3px solid #64748b"}}>
              <div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>TBD</div>
              <div style={{fontSize:18,fontWeight:700,color:"#64748b"}}>{rows.filter(r=>r.sprint==="TBD"&&!DONE_STATUSES.has(r.status)).length}</div>
              <div style={{fontSize:10,color:"#475569",marginTop:2}}>unscheduled</div>
            </div>
          )}
          <div style={{background:"#1e293b",borderRadius:8,padding:"10px 14px",flex:1,minWidth:90,borderLeft:"3px solid #22c55e"}}>
            <div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>Total</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9"}}>
              {totalPtsLeft}<span style={{fontSize:10,color:"#64748b",fontWeight:400,marginLeft:3}}>pts</span>
            </div>
            <div style={{fontSize:10,color:"#f59e0b",marginTop:3}}>{totalTbd} TBD</div>
            <div style={{fontSize:10,color:"#475569",marginTop:2}}>{rows.filter(r=>!DONE_STATUSES.has(r.status)).length} tickets</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   EPIC VIEW
   ═══════════════════════════════════════════════════════════════════════ */
function EpicView({rows,filters,allThemes}){
  const[expanded,setExpanded]=useState(new Set());
  const toggle=t=>setExpanded(s=>{const n=new Set(s);n.has(t)?n.delete(t):n.add(t);return n;});
  const baseRows=rows.filter(r=>{
    if(DONE_STATUSES.has(r.status)&&!filters.showDone) return false;
    if(filters.team!=="All"&&r.team!==filters.team) return false;
    if(filters.sprint!=="All"&&r.sprint!==filters.sprint) return false;
    if(filters.priority!=="All"&&r.priority!==filters.priority) return false;
    if(filters.status!=="All"&&r.status!==filters.status) return false;
    if(filters.newOnly&&CFG.keyPrefix&&r.id.startsWith(CFG.keyPrefix)) return false;
    return true;
  });
  const themeGroups={};
  baseRows.forEach(r=>{if(!themeGroups[r.theme])themeGroups[r.theme]=[];themeGroups[r.theme].push(r);});
  const themes=Object.keys(themeGroups).sort((a,b)=>themeGroups[b].reduce((s,r)=>s+(r.points||0),0)-themeGroups[a].reduce((s,r)=>s+(r.points||0),0));
  const SG={"Done":["Done"],"In Progress":["In Progress","In Testing","Code Review"],"Ready":["Ready for Sprint","PO Sign Off"],"Blocked":["Requirements Gathering","Awaiting Estimation","Analysis","Blocked"],"Backlog":["Product Backlog","To Do","Cancelled"]};
  const SGC={"Done":"#22c55e","In Progress":"#3b82f6","Ready":"#06b6d4","Blocked":"#f97316","Backlog":"#475569"};
  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {themes.map(theme=>{
        const tickets=themeGroups[theme];
        const col=allThemes[theme]||"#64748b";
        const total=tickets.length;
        const done=tickets.filter(r=>DONE_STATUSES.has(r.status)).length;
        const pct=total>0?Math.round((done/total)*100):0;
        const totalPts=tickets.reduce((s,r)=>s+(r.points||0),0);
        const tbdPts=tickets.filter(r=>r.points===null&&!DONE_STATUSES.has(r.status)).length;
        const teams=sortTeams([...new Set(tickets.map(r=>r.team).filter(Boolean))]);
        const groups={};
        Object.entries(SG).forEach(([g,ss])=>{groups[g]=tickets.filter(r=>ss.includes(r.status)).length;});
        const isOpen=expanded.has(theme);
        return(
          <div key={theme} style={{background:"#1e293b",borderRadius:10,border:"1px solid #334155",overflow:"hidden"}}>
            <div onClick={()=>toggle(theme)}
              style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",cursor:"pointer",borderLeft:"4px solid "+col}}
              onMouseEnter={e=>e.currentTarget.style.background="#243044"}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
              <div style={{display:"flex",alignItems:"center",gap:8,minWidth:180}}>
                <span style={{width:10,height:10,borderRadius:"50%",background:col,flexShrink:0}}/>
                <span style={{fontSize:13,fontWeight:700,color:col}}>{theme}</span>
              </div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap",minWidth:100}}>
                {teams.map(t=>{const tc=teamColor(t);return <span key={t} style={{fontSize:9,fontWeight:700,color:tc,background:tc+"22",padding:"2px 7px",borderRadius:10,border:"1px solid "+tc+"55"}}>{teamLabel(t)}</span>;})}
              </div>
              <div style={{flex:1,minWidth:120}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:10,color:"#94a3b8"}}>{done}/{total} done</span>
                  <span style={{fontSize:10,color:pct===100?"#22c55e":"#94a3b8",fontWeight:600}}>{pct}%</span>
                </div>
                <div style={{height:5,background:"#0f172a",borderRadius:3,overflow:"hidden"}}>
                  <div style={{height:"100%",width:pct+"%",background:pct===100?"#22c55e":col,borderRadius:3,transition:"width 0.3s"}}/>
                </div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {Object.entries(groups).map(([g,n])=>n>0&&(<Tip key={g} text={g}><span style={{fontSize:11,fontWeight:600,color:SGC[g],cursor:"default"}}>{n}</span></Tip>))}
              </div>
              <div style={{textAlign:"right",minWidth:80}}>
                <span style={{fontSize:15,fontWeight:700,color:"#f1f5f9"}}>{totalPts}</span>
                <span style={{fontSize:10,color:"#64748b",marginLeft:3}}>pts</span>
                {tbdPts>0&&<div style={{fontSize:9,color:"#f59e0b"}}>+{tbdPts} TBD</div>}
              </div>
              <span style={{fontSize:11,color:"#475569",marginLeft:4}}>{isOpen?"▲":"▼"}</span>
            </div>
            {isOpen&&(
              <div style={{borderTop:"1px solid #334155"}}>
                <div style={{display:"grid",gridTemplateColumns:"60px 90px 1fr 110px 100px 45px 130px",background:"#0f172a",padding:"5px 16px",fontSize:9,fontWeight:600,color:"#475569",textTransform:"uppercase",letterSpacing:0.5}}>
                  <span>Team</span><span>ID</span><span>Title</span><span>Priority</span><span>Sprint</span><span>Pts</span><span>Status</span>
                </div>
                {tickets.map((r,i)=>{
                  const sc=STATUS_COL[r.status]||"#64748b";
                  const pc=PRIORITY_COL[r.priority]||"#64748b";
                  const tc=teamColor(r.team);const rowBg=i%2===0?"#1e293b":"#192236";
                  const spCol=sprintCol(sprintNumOf(r.sprint));
                  return(
                    <div key={r._id} style={{display:"grid",gridTemplateColumns:"60px 90px 1fr 110px 100px 45px 130px",padding:"6px 16px",background:rowBg,borderTop:"1px solid #0f172a",alignItems:"center",opacity:DONE_STATUSES.has(r.status)?0.5:1}}>
                      <span style={{fontSize:9,fontWeight:700,color:tc,background:tc+"22",padding:"1px 5px",borderRadius:3,width:"fit-content",border:"1px solid "+tc+"55"}}>{teamLabel(r.team)||"?"}</span>
                      <span style={{fontSize:10,fontFamily:"monospace",color:"#60a5fa"}}>{r.id}</span>
                      <span style={{fontSize:11,fontWeight:600,color:"#f1f5f9",paddingRight:8,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{r.title}</span>
                      <span style={{fontSize:10,color:pc,fontWeight:600}}>{r.priority}</span>
                      <span style={{fontSize:10,color:spCol,fontWeight:600}}>{r.sprint}</span>
                      <span style={{fontSize:11,fontWeight:700,color:r.points!=null?"#f59e0b":"#475569"}}>{r.points??"-"}</span>
                      <span style={{fontSize:9,fontWeight:600,color:sc,background:sc+"22",padding:"2px 6px",borderRadius:3,width:"fit-content"}}>{r.status}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {themes.length===0&&<div style={{textAlign:"center",padding:"60px",color:"#475569",fontSize:13}}>No epics match the current filters</div>}
    </div>
  );
}
/* ═══════════════════════════════════════════════════════════════════════
   TIMELINE VIEW (burndown + Beta/GA health + Gantt forecast)
   ═══════════════════════════════════════════════════════════════════════ */
function CriticalBurnChart({rows,assumeTBD}){
  const[showTeams,setShowTeams]=useState(new Set(["All"]));
  const[hoverSprintIdx,setHoverSprintIdx]=useState(null);
  const svgRef=useRef();
  const allTeams=sortTeams([...new Set(rows.map(r=>r.team).filter(Boolean))]);
  const eff=r=>assumeTBD&&r.points===null?3:(r.points||0);
  const allSprintNums=[...new Set(rows.map(r=>r.sprint).filter(s=>s&&s!=="TBD").map(sprintNumOf))].filter(n=>n>0).sort((a,b)=>a-b);
  if(allSprintNums.length===0) return null;
  function openPtsAfter(team,afterN){return rows.filter(r=>{if(DONE_STATUSES.has(r.status))return false;if(team&&r.team!==team)return false;const rn=sprintNumOf(r.sprint);return r.sprint==="TBD"||rn>afterN;}).reduce((a,r)=>a+eff(r),0);}
  function ptsInSprint(team,n){return rows.filter(r=>{if(DONE_STATUSES.has(r.status))return false;if(team&&r.team!==team)return false;return r.sprint==="Sprint "+n;}).reduce((a,r)=>a+eff(r),0);}
  const teams=showTeams.has("All")?["All",...allTeams]:allTeams.filter(t=>showTeams.has(t));
  const series=teams.map(t=>{const team=t==="All"?null:t;const col=t==="All"?"#e2e8f0":teamColor(t);const startN=allSprintNums[0]-1;const points=[startN,...allSprintNums].map(n=>({n,pts:openPtsAfter(team,n)}));return{team:t,col,points};});
  const barData=allSprintNums.map(n=>({n,total:allTeams.reduce((a,t)=>a+ptsInSprint(t,n),0)}));
  const maxPts=Math.max(...series.flatMap(s=>s.points.map(p=>p.pts)),1);
  const H=260,W_PER_COL=72,LEFT_PAD=52,BOTTOM_PAD=44;
  const chartW=Math.max(allSprintNums.length*W_PER_COL+LEFT_PAD+20,440);
  const yPx=pts=>H-Math.round((pts/maxPts)*H);
  const xPx=idx=>LEFT_PAD+idx*W_PER_COL+W_PER_COL/2;
  const firstStart=sprintStartDate(allSprintNums[0]);
  const lastEnd=sprintEndDate(allSprintNums[allSprintNums.length-1]);
  const totalMs=Math.max(lastEnd-firstStart,1);
  const dateToX=d=>{const frac=Math.max(0,Math.min(1,(d-firstStart)/totalMs));return LEFT_PAD+frac*(allSprintNums.length*W_PER_COL);};
  const _ms=trackedMilestones(),m1=_ms[0],m2=_ms[1];
  const bD=m1?m1.date:null,gD=m2?m2.date:null;
  const betaX=bD?dateToX(bD):-1,gaX=gD?dateToX(gD):-1,todayX=dateToX(new Date());
  const showBeta=bD&&betaX>LEFT_PAD&&betaX<chartW;
  const showGA=gD&&gaX>LEFT_PAD&&gaX<chartW+60;
  function handleMove(e){if(!svgRef.current)return;const rect=svgRef.current.getBoundingClientRect();const scaleX=chartW/rect.width;const mx=(e.clientX-rect.left)*scaleX;let best=null,bestD=999;allSprintNums.forEach((n,i)=>{const d=Math.abs(mx-xPx(i+1));if(d<bestD){bestD=d;best=i;}});setHoverSprintIdx(best!==null&&bestD<W_PER_COL?best:null);}
  const toggleTeam=t=>setShowTeams(prev=>{const next=new Set(prev);if(t==="All")return new Set(["All"]);next.delete("All");if(next.has(t))next.delete(t);else next.add(t);if(next.size===0)return new Set(["All"]);return next;});
  const yTicks=[0,0.2,0.4,0.6,0.8,1].map(f=>Math.round(f*maxPts));
  return(
    <div style={{background:"#1e293b",borderRadius:10,padding:"18px 22px",border:"1px solid #334155",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div><span style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1}}>Points Burndown by Team</span>{assumeTBD&&<span style={{fontSize:9,color:"#f59e0b",marginLeft:8}}>⚡ TBD as 3pts</span>}</div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {["All",...allTeams].map(t=>{const active=showTeams.has(t);const tc=t==="All"?"#94a3b8":teamColor(t);return(<button key={t} onClick={()=>toggleTeam(t)} style={{padding:"2px 10px",borderRadius:10,border:active?"1px solid "+tc:"1px solid "+tc+"44",background:active?tc+"33":"transparent",color:active?tc:tc+"66",fontSize:10,fontWeight:700,cursor:"pointer",lineHeight:"18px"}}>{t==="All"?"All":teamLabel(t)}</button>);})}
        </div>
      </div>
      <div style={{flex:1,width:"100%",position:"relative"}}>
        {hoverSprintIdx!==null&&(()=>{const n=allSprintNums[hoverSprintIdx];const cx=xPx(hoverSprintIdx+1);const svgW=svgRef.current?svgRef.current.getBoundingClientRect().width:chartW;const scaledX=(cx/chartW)*svgW;return(
          <div style={{position:"absolute",left:scaledX,top:0,transform:"translateX(-50%)",zIndex:10,pointerEvents:"none",background:"#0f172a",border:"1px solid #334155",borderRadius:8,padding:"8px 12px",minWidth:140,boxShadow:"0 4px 16px rgba(0,0,0,0.6)"}}>
            <div style={{fontSize:9,fontWeight:700,color:sprintCol(n),marginBottom:5}}>Sprint {n} — {fmtDate(sprintEndDate(n))}</div>
            {series.map(s2=>(<div key={s2.team} style={{display:"flex",justifyContent:"space-between",gap:12,marginBottom:2}}><span style={{fontSize:9,color:s2.col,fontWeight:s2.team==="All"?700:400}}>{s2.team==="All"?"All":teamLabel(s2.team)}</span><span style={{fontSize:9,color:s2.col,fontWeight:700}}>{s2.points[hoverSprintIdx+1]?.pts??"-"}pts</span></div>))}
          </div>);})()}
        <svg ref={svgRef} viewBox={"0 0 "+chartW+" "+(H+BOTTOM_PAD)} style={{display:"block",width:"100%",height:"auto"}} preserveAspectRatio="xMidYMid meet" onMouseMove={handleMove} onMouseLeave={()=>setHoverSprintIdx(null)}>
          {yTicks.map(v=>{const y=yPx(v);const z=v===0;return(<g key={v}><line x1={LEFT_PAD} y1={y} x2={chartW-10} y2={y} stroke={z?"#334155":"#1e3a5f"} strokeWidth={z?1.5:1}/><text x={LEFT_PAD-6} y={y+4} fill="#475569" fontSize={9} textAnchor="end">{v}</text></g>);})}
          {allSprintNums.map((n,i)=>{const x=xPx(i+1);const col=sprintCol(n);const act=isActive(n);const barH=Math.round((barData[i].total/maxPts)*H);return(<g key={n}><rect x={x-W_PER_COL*0.35} y={H-barH} width={W_PER_COL*0.7} height={barH} fill={col} opacity={0.08} rx={3}/><line x1={x} y1={0} x2={x} y2={H} stroke={act?col+"55":"#1e3a5f"} strokeWidth={act?1.5:1} strokeDasharray={act?"":"3,4"}/><rect x={x-14} y={H+6} width={28} height={14} fill={act?col+"33":"#0f172a"} rx={4}/><text x={x} y={H+17} fill={col} fontSize={act?9:8} textAnchor="middle" fontWeight={act?800:600}>S{n}</text><text x={x} y={H+34} fill={col+"99"} fontSize={7} textAnchor="middle">{fmtDate(sprintEndDate(n))}</text></g>);})}
          {showBeta&&m1&&(<g><line x1={betaX} y1={0} x2={betaX} y2={H} stroke={m1.color} strokeWidth={1.5} strokeDasharray="5,4"/><rect x={betaX-1} y={2} width={70} height={14} fill="#1e293b" rx={3}/><text x={betaX+4} y={13} fill={m1.color} fontSize={9} fontWeight={700}>{m1.label} {fmtDate(bD)}</text></g>)}
          {showGA&&m2&&(<g><line x1={gaX} y1={0} x2={gaX} y2={H} stroke={m2.color} strokeWidth={1.5} strokeDasharray="5,4"/><rect x={Math.min(gaX-1,chartW-72)} y={18} width={68} height={14} fill="#1e293b" rx={3}/><text x={Math.min(gaX+4,chartW-66)} y={29} fill={m2.color} fontSize={9} fontWeight={700}>{m2.label} {fmtDate(gD)}</text></g>)}
          {todayX>LEFT_PAD&&todayX<chartW&&(<g><line x1={todayX} y1={0} x2={todayX} y2={H} stroke="#22c55e" strokeWidth={2}/><rect x={todayX+3} y={H-18} width={34} height={14} fill="#1e293b" rx={3}/><text x={todayX+6} y={H-7} fill="#22c55e" fontSize={9} fontWeight={700}>Today</text></g>)}
          {[...series].reverse().map(s=>{const pts=s.points;const isAll=s.team==="All";const pathD=pts.map((p,i)=>{const x=i===0?LEFT_PAD:xPx(i);const y=yPx(p.pts);return(i===0?"M":"L")+x+","+y;}).join(" ");return(<g key={s.team}><path d={pathD} fill="none" stroke={s.col} strokeWidth={isAll?3:2} strokeLinejoin="round" strokeLinecap="round" opacity={isAll?1:0.85}/>{pts.map((p,i)=>{const x=i===0?LEFT_PAD:xPx(i);const y=yPx(p.pts);return <circle key={i} cx={x} cy={y} r={isAll?4:3} fill={s.col} stroke="#1e293b" strokeWidth={1.5}/>;})}</g>);})}
          <line x1={LEFT_PAD} y1={0} x2={LEFT_PAD} y2={H} stroke="#334155" strokeWidth={1.5}/>
          <line x1={LEFT_PAD} y1={H} x2={chartW-10} y2={H} stroke="#334155" strokeWidth={1.5}/>
        </svg>
      </div>
      <div style={{display:"flex",gap:12,marginTop:10,flexWrap:"wrap",alignItems:"center"}}>
        {series.map(s=>(<div key={s.team} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:18,height:s.team==="All"?3:2,borderRadius:2,background:s.col}}/><span style={{fontSize:9,color:s.col,fontWeight:s.team==="All"?700:500}}>{s.team==="All"?"All":teamLabel(s.team)}</span></div>))}
      </div>
    </div>
  );
}

function TimelineView({rows,allThemes,onMarkAllCritical,teamCapacity}){
  const[assumeTBD,setAssumeTBD]=useState(false);
  const[markConfirm,setMarkConfirm]=useState(false);
  const VEL=CFG.defaultTeamCap||36;
  const allTeams=sortTeams([...new Set(rows.map(r=>r.team).filter(Boolean))]);
  const eff=r=>assumeTBD&&r.points===null?3:(r.points||0);
  const allSprintNums=[...new Set(rows.map(r=>r.sprint).filter(s=>s&&s!=="TBD").map(sprintNumOf))].filter(n=>n>0).sort((a,b)=>a-b);
  const _ms=trackedMilestones(),m1=_ms[0],m2=_ms[1];
  const bD=m1?m1.date:null,gD=m2?m2.date:null;
  function sprintForDate(d){if(!d)return allSprintNums[allSprintNums.length-1]||0;for(const n of allSprintNums){if(d<=sprintEndDate(n))return n;}return allSprintNums[allSprintNums.length-1]||0;}
  const betaSprint=sprintForDate(bD),gaSprint=sprintForDate(gD),curSprint=currentSprintNum();
  const numTeams=Math.max(allTeams.length,1);
  const getTeamSprintCap=(team,n)=>(teamCapacity&&teamCapacity["Sprint "+n+":"+team])||VEL;
  function teamCapUpTo(team,endN){let total=0;for(const n of allSprintNums){if(n>=curSprint&&n<=endN)total+=getTeamSprintCap(team,n);}return total;}
  function teamMetrics(team){
    const teamRows=team?rows.filter(r=>r.team===team):rows;
    const open=teamRows.filter(r=>!DONE_STATUSES.has(r.status));
    const totalPts=open.reduce((a,r)=>a+eff(r),0);
    const tbdCount=open.filter(r=>r.points===null).length;
    const critPts=open.filter(r=>r.priority===topPriority()).reduce((a,r)=>a+eff(r),0);
    const highPts=open.filter(r=>r.priority===secondPriority()).reduce((a,r)=>a+eff(r),0);
    const sprintsBeforeBeta=Math.max(0,betaSprint-curSprint+1);
    const sprintsBeforeGA=Math.max(0,gaSprint-curSprint+1);
    let capacityBeta,capacityGA;
    if(team){capacityBeta=teamCapUpTo(team,betaSprint);capacityGA=teamCapUpTo(team,gaSprint);}
    else{capacityBeta=allTeams.reduce((a,t)=>a+teamCapUpTo(t,betaSprint),0);capacityGA=allTeams.reduce((a,t)=>a+teamCapUpTo(t,gaSprint),0);}
    const betaGap=critPts-capacityBeta;const gaGap=(critPts+highPts)-capacityGA;
    return{totalPts,tbdCount,critPts,highPts,betaGap,gaGap,sprintsBeforeBeta,sprintsBeforeGA,capacityBeta,capacityGA,ticketCount:open.length};
  }
  const overall=teamMetrics(null);
  const teamData=allTeams.map(t=>({team:t,col:teamColor(t),...teamMetrics(t)}));
  const chartStart=allSprintNums.length>0?sprintStartDate(allSprintNums[0]):anchorDate();
  const chartEnd=allSprintNums.length>0?sprintEndDate(allSprintNums[allSprintNums.length-1]):sprintEndDate(CFG.anchorNum+5);
  const totalMs=Math.max(chartEnd.getTime()-chartStart.getTime(),1);
  const tpct=d=>{if(!d)return 0;return Math.max(0,Math.min(100,((d.getTime()-chartStart.getTime())/totalMs)*100));};
  function latestEnd(tickets){let max=null;for(const r of tickets){const n=sprintNumOf(r.sprint);if(!n)continue;const d=sprintEndDate(n);if(!max||d>max)max=d;}return max;}
  const themeNames=[...new Set(rows.map(r=>r.theme).filter(Boolean))];
  const themeData=themeNames.map(theme=>{
    const all=rows.filter(r=>r.theme===theme);const open=all.filter(r=>!DONE_STATUSES.has(r.status));
    const doneCount=all.length-open.length;
    const openCrit=open.filter(r=>r.priority===topPriority());const openHigh=open.filter(r=>r.priority===secondPriority());
    const openCritHigh=open.filter(r=>r.priority===topPriority()||r.priority===secondPriority());
    const critDate=latestEnd(openCrit.filter(r=>r.sprint&&r.sprint!=="TBD"));
    const critHighDate=latestEnd(openCritHigh.filter(r=>r.sprint&&r.sprint!=="TBD"));
    const tbdCrit=openCrit.filter(r=>!r.sprint||r.sprint==="TBD").length;
    const tbdHigh=openHigh.filter(r=>!r.sprint||r.sprint==="TBD").length;
    const ptsRem=open.reduce((a,r)=>a+eff(r),0);const tbdPtsCount=open.filter(r=>r.points===null).length;
    const pctDone=all.length>0?Math.round((doneCount/all.length)*100):0;
    const col=allThemes[theme]||"#64748b";
    return{theme,col,total:all.length,doneCount,open:open.length,critDate,critHighDate,critPct:tpct(critDate),critHighPct:tpct(critHighDate),tbdCrit,tbdHigh,critCount:openCrit.length,highCount:openHigh.length,ptsRem,tbdPtsCount,pctDone};
  }).filter(t=>t.total>0).sort((a,b)=>{if(a.critDate&&b.critDate)return a.critDate-b.critDate;if(a.critDate)return -1;if(b.critDate)return 1;if(a.critHighDate&&b.critHighDate)return a.critHighDate-b.critHighDate;if(a.critHighDate)return -1;if(b.critHighDate)return 1;return a.theme.localeCompare(b.theme);});
  const markers=allSprintNums.map(n=>({n,date:sprintEndDate(n),col:sprintCol(n),p:tpct(sprintEndDate(n))}));
  const todayP=tpct(new Date()),betaP=tpct(bD),gaP=tpct(gD);
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
        <Tip text={assumeTBD?"Unpointed included as 3pts each (click to disable)":"Count unpointed tickets as 3pts each in all calculations"}>
          <button onClick={()=>setAssumeTBD(v=>!v)} style={{padding:"6px 10px",borderRadius:7,border:assumeTBD?"1px solid #f59e0b":"1px solid #334155",background:assumeTBD?"rgba(245,158,11,0.18)":"#1e293b",color:assumeTBD?"#fbbf24":"#64748b",fontSize:14,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",gap:5}}>⚡{assumeTBD&&<span style={{fontSize:10,fontWeight:700,color:"#fbbf24"}}>{rows.filter(r=>!DONE_STATUSES.has(r.status)&&r.points===null).length} TBD → 3pts</span>}</button>
        </Tip>
        <Tip text={"Mark every open ticket "+topPriority()+" ("+(m1?m1.label:"first milestone")+" scope) as a starting point, then demote. Priority is preserved on import."}>
          {!markConfirm?(<button onClick={()=>setMarkConfirm(true)} style={{padding:"6px 10px",borderRadius:7,border:"1px solid #7c3aed44",background:"#1e293b",color:"#a78bfa",fontSize:14,cursor:"pointer",lineHeight:1}}>🔴</button>):(
            <div style={{display:"flex",gap:5,alignItems:"center",background:"rgba(124,58,237,0.15)",border:"1px solid #7c3aed",borderRadius:7,padding:"4px 10px"}}>
              <span style={{fontSize:11,color:"#a78bfa",fontWeight:600}}>Mark all {rows.filter(r=>!DONE_STATUSES.has(r.status)).length} open as Critical?</span>
              <button onClick={()=>{onMarkAllCritical();setMarkConfirm(false);}} style={{padding:"2px 10px",background:"#7c3aed",color:"#fff",border:"none",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
              <button onClick={()=>setMarkConfirm(false)} style={{padding:"2px 8px",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:4,cursor:"pointer",fontSize:11}}>No</button>
            </div>)}
        </Tip>
        <div style={{marginLeft:"auto",fontSize:10,color:"#475569"}}>🔴 = {m1?m1.label:"M1"} scope · 🟠 = {m2?m2.label:"M2"} scope · @ {VEL}pts/team/sprint</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16,alignItems:"start"}}>
        <CriticalBurnChart rows={rows} assumeTBD={assumeTBD}/>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {[
            m1&&{label:m1.label,date:fmtDate(m1.date),gap:overall.betaGap,cap:overall.capacityBeta,pts:overall.critPts,sprints:overall.sprintsBeforeBeta,scope:topPriority(),col:m1.color,lightCol:m1.color},
            m2&&{label:m2.label,date:fmtDate(m2.date),gap:overall.gaGap,cap:overall.capacityGA,pts:overall.critPts+overall.highPts,sprints:overall.sprintsBeforeGA,scope:topPriority()+" + "+secondPriority(),col:m2.color,lightCol:m2.color}
          ].filter(Boolean).map(m=>{
            const onTrack=m.gap<=0;const statusCol=onTrack?"#22c55e":"#ef4444";const rawPct=m.cap>0?Math.min(100,Math.round((m.pts/m.cap)*100)):100;
            const R=22,CIRC=2*Math.PI*R;const fillArc=Math.min(rawPct/100,1)*CIRC;const arcCol=onTrack?m.col:"#ef4444";
            return(<div key={m.label} style={{background:"#1e293b",border:"1px solid #334155",borderLeft:"4px solid "+m.col,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:12}}>
              <svg width={54} height={54} style={{flexShrink:0}}><circle cx={27} cy={27} r={R} fill="none" stroke="#0f172a" strokeWidth={6}/><circle cx={27} cy={27} r={R} fill="none" stroke={arcCol} strokeWidth={6} strokeDasharray={fillArc+" "+(CIRC-fillArc)} strokeDashoffset={CIRC/4} strokeLinecap="round"/><text x={27} y={31} fill={arcCol} fontSize={10} fontWeight={800} textAnchor="middle">{rawPct}%</text></svg>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{width:8,height:8,borderRadius:"50%",background:m.col,display:"inline-block"}}/><span style={{fontSize:12,fontWeight:800,color:m.lightCol}}>{m.label}</span><span style={{fontSize:9,color:"#64748b"}}>{m.date}</span><span style={{marginLeft:"auto",fontSize:9,fontWeight:700,color:statusCol,background:statusCol+"18",padding:"1px 7px",borderRadius:4,border:"1px solid "+statusCol+"33"}}>{onTrack?"✓ OK":"⚠ Risk"}</span></div>
                <div style={{fontSize:9,color:"#64748b",marginBottom:2}}>{m.scope} · {m.sprints}sp · {numTeams} teams</div>
                <div style={{display:"flex",gap:8,fontSize:10}}><span style={{color:"#f1f5f9",fontWeight:700}}>{m.pts}pts</span><span style={{color:"#475569"}}>scope ·</span><span style={{color:m.lightCol,fontWeight:700}}>{m.cap}pts</span><span style={{color:"#475569"}}>cap ·</span><span style={{fontWeight:700,color:onTrack?"#22c55e":"#ef4444"}}>{onTrack?"+"+(m.cap-m.pts):m.gap+"pts"}</span></div>
              </div>
            </div>);
          })}
          <div style={{background:"#1e293b",borderRadius:10,border:"1px solid #334155",overflow:"hidden"}}>
            <div style={{background:"#0f172a",padding:"7px 12px",fontSize:9,fontWeight:600,color:"#475569",textTransform:"uppercase",letterSpacing:0.5}}>Team Breakdown</div>
            {teamData.map((t,i)=>{
              const betaOk=t.betaGap<=0,gaOk=t.gaGap<=0;const rowBg=i%2===0?"#1e293b":"#192236";
              const betaCol=betaOk?"#22c55e":"#ef4444",gaCol=gaOk?"#22c55e":"#f97316";
              const noPriority=t.critPts===0&&t.highPts===0;
              return(<div key={t.team} style={{background:rowBg,padding:"8px 12px",borderTop:"1px solid #0f172a"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <span style={{fontSize:10,fontWeight:700,color:t.col,background:t.col+"22",padding:"1px 8px",borderRadius:4,border:"1px solid "+t.col+"44"}}>{teamLabel(t.team)}</span>
                  <span style={{fontSize:11,fontWeight:700,color:"#f1f5f9"}}>{t.totalPts}pts</span>
                  {t.tbdCount>0&&<span style={{fontSize:9,color:"#f59e0b"}}>+{t.tbdCount} TBD</span>}
                  <div style={{marginLeft:"auto",display:"flex",gap:4}}>
                    {m1&&<span style={{fontSize:9,fontWeight:700,color:betaCol,background:betaCol+"15",padding:"2px 7px",borderRadius:3,border:"1px solid "+betaCol+"33"}}>{betaOk?m1.label+" ✓":m1.label+" "+(t.betaGap>0?"+"+t.betaGap:t.betaGap)}</span>}
                    {m2&&<span style={{fontSize:9,fontWeight:700,color:gaCol,background:gaCol+"15",padding:"2px 7px",borderRadius:3,border:"1px solid "+gaCol+"33"}}>{gaOk?m2.label+" ✓":m2.label+" "+(t.gaGap>0?"+"+t.gaGap:t.gaGap)}</span>}
                  </div>
                </div>
                <div style={{height:10,borderRadius:5,overflow:"hidden",background:"#0f172a",marginBottom:4,position:"relative"}}>
                  <div style={{position:"absolute",left:0,top:0,height:"100%",width:"100%",background:"#1d4ed8"}}/>
                  <div style={{position:"absolute",left:0,top:0,height:"100%",width:Math.min(100,(noPriority?t.totalPts:t.critPts)/Math.max(t.capacityGA,1)*100)+"%",background:noPriority?"#64748b":"#ef4444"}}/>
                  {!noPriority&&t.highPts>0&&(<div style={{position:"absolute",left:(t.critPts/Math.max(t.capacityGA,1)*100)+"%",top:0,height:"100%",width:(t.highPts/Math.max(t.capacityGA,1)*100)+"%",background:"#22c55e"}}/>)}
                  <div style={{position:"absolute",left:(t.capacityBeta/Math.max(t.capacityGA,1)*100)+"%",top:0,height:"100%",width:3,background:"#fff",opacity:0.5}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  {noPriority?(<span style={{fontSize:8,color:"#64748b"}}>⚠ {t.totalPts}pts — assign priorities to see milestone split</span>):(
                    <div style={{display:"flex",gap:8}}><span style={{fontSize:8,color:"#ef4444"}}>🔴 {t.critPts}pts {m1?m1.label:""}</span>{t.highPts>0&&<span style={{fontSize:8,color:"#22c55e"}}>🟢 +{t.highPts}pts {m2?m2.label:""}</span>}</div>)}
                  <span style={{fontSize:8,color:"#60a5fa"}}>cap: {t.capacityBeta}β / {t.capacityGA}GA</span>
                </div>
              </div>);
            })}
          </div>
        </div>
      </div>
      <div style={{background:"#1e293b",borderRadius:10,padding:"16px 20px",marginBottom:16,border:"1px solid #334155"}}>
        <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Epic Delivery Forecast</div>
        <div style={{overflowX:"auto"}}><div style={{minWidth:540}}>
          <div style={{display:"flex",marginBottom:4}}><div style={{width:148,flexShrink:0}}/><div style={{flex:1,position:"relative",height:24}}>{markers.map(m=>(<div key={m.n} style={{position:"absolute",left:m.p+"%",transform:"translateX(-50%)",textAlign:"center",pointerEvents:"none"}}><div style={{fontSize:9,fontWeight:700,color:m.col}}>S{m.n}</div><div style={{fontSize:8,color:m.col+"99"}}>{fmtDate(m.date)}</div></div>))}</div></div>
          <div style={{position:"relative"}}>
            {markers.map(m=>(<div key={m.n} style={{position:"absolute",top:0,bottom:0,left:m.p+"%",width:1,background:"#1e3a5f",zIndex:0,pointerEvents:"none"}}/>))}
            <div style={{position:"absolute",top:0,bottom:0,left:todayP+"%",width:2,background:"#22c55e55",zIndex:1,pointerEvents:"none"}}/>
            {bD&&betaP>=0&&betaP<=100&&<div style={{position:"absolute",top:0,bottom:0,left:betaP+"%",width:2,background:(m1?m1.color:"#a78bfa")+"88",zIndex:1,pointerEvents:"none"}}/>}
            {gD&&gaP>=0&&gaP<=100&&<div style={{position:"absolute",top:0,bottom:0,left:gaP+"%",width:2,background:(m2?m2.color:"#38bdf8")+"88",zIndex:1,pointerEvents:"none"}}/>}
            {themeData.map((t,i)=>{const rowBg=i%2===0?"rgba(15,23,42,0.5)":"transparent";return(
              <div key={t.theme} style={{display:"flex",alignItems:"center",padding:"4px 0",background:rowBg,borderRadius:3,position:"relative",zIndex:2,minHeight:36}}>
                <div style={{width:148,flexShrink:0,display:"flex",alignItems:"center",gap:5,paddingRight:8}}><span style={{width:7,height:7,borderRadius:"50%",background:t.col,flexShrink:0}}/><span style={{fontSize:10,fontWeight:600,color:"#f1f5f9",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{t.theme}</span></div>
                <div style={{flex:1,position:"relative",height:32}}>
                  {t.critDate?(<div style={{position:"absolute",left:0,top:1,height:13,width:t.critPct+"%",background:t.col+"dd",borderRadius:"0 3px 3px 0",display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:4,overflow:"hidden",minWidth:4}}><span style={{fontSize:8,color:"#fff",fontWeight:700,whiteSpace:"nowrap"}}>{fmtDate(t.critDate)}</span></div>):(t.tbdCrit>0&&(<div style={{position:"absolute",left:4,top:2,height:12,display:"flex",alignItems:"center"}}><span style={{fontSize:8,color:"#ef4444"}}>{"🔴 "+t.tbdCrit+" unscheduled"}</span></div>))}
                  {t.critHighDate?(<div style={{position:"absolute",left:0,top:17,height:13,width:t.critHighPct+"%",background:t.col+"55",borderRadius:"0 3px 3px 0",display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:4,overflow:"hidden",minWidth:4}}><span style={{fontSize:8,color:"#f1f5f9",whiteSpace:"nowrap"}}>{fmtDate(t.critHighDate)}</span></div>):((t.tbdCrit>0||t.tbdHigh>0)&&(<div style={{position:"absolute",left:4,top:17,height:12,display:"flex",alignItems:"center"}}><span style={{fontSize:8,color:"#f97316"}}>{(t.tbdCrit+t.tbdHigh)+" unscheduled"}</span></div>))}
                </div>
              </div>);})}
          </div>
        </div></div>
      </div>
      <div style={{fontSize:10,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Epic Summary</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
        {themeData.map(t=>(<div key={t.theme} style={{background:"#1e293b",borderRadius:8,padding:"12px",border:"1px solid #334155",borderLeft:"3px solid "+t.col}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:6}}><span style={{width:7,height:7,borderRadius:"50%",background:t.col,flexShrink:0}}/><span style={{fontSize:11,fontWeight:700,color:t.col,flex:1,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{t.theme}</span><span style={{fontSize:10,fontWeight:700,color:t.pctDone===100?"#22c55e":"#94a3b8"}}>{t.pctDone}%</span></div>
          <div style={{height:3,background:"#0f172a",borderRadius:2,overflow:"hidden",marginBottom:10}}><div style={{height:"100%",width:t.pctDone+"%",background:t.pctDone===100?"#22c55e":t.col,borderRadius:2}}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3,marginBottom:8}}>{[{l:"Open",v:t.open,c:"#f1f5f9"},{l:"Pts",v:t.ptsRem,c:"#f59e0b"},{l:"Crit",v:t.critCount,c:"#ef4444"},{l:"High",v:t.highCount,c:"#f97316"}].map(s=>(<div key={s.l} style={{textAlign:"center"}}><div style={{fontSize:8,color:"#475569",marginBottom:1}}>{s.l}</div><div style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div></div>))}</div>
          {t.tbdPtsCount>0&&<div style={{fontSize:9,color:"#f59e0b",marginBottom:6}}>+{t.tbdPtsCount} unpointed</div>}
          {(t.critDate||t.critHighDate)&&(<div style={{borderTop:"1px solid #334155",paddingTop:6,display:"flex",flexDirection:"column",gap:3}}>{t.critDate&&<div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:9,color:"#ef4444"}}>Beta by</span><span style={{fontSize:9,fontWeight:700,color:"#ef4444"}}>{fmtDate(t.critDate)}</span></div>}{t.critHighDate&&<div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:9,color:"#f97316"}}>GA by</span><span style={{fontSize:9,fontWeight:700,color:"#f97316"}}>{fmtDate(t.critHighDate)}</span></div>}</div>)}
        </div>))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ROADMAP VIEW — OBX gold-standard design + live, cached AI summaries.
   ═══════════════════════════════════════════════════════════════════════ */
function AISummary({ticket,aiCache,ensureSummary}){
  const desc=(ticket.desc||"").trim();
  useEffect(()=>{ if(desc) ensureSummary(ticket); },[ticket.id,hashStr(desc)]); // eslint-disable-line
  const cached=aiCache[ticket.id];
  const fresh=cached&&cached.hash===hashStr(desc)&&cached.text;
  const text=fresh?cached.text:condense(ticket);
  const generating=!!desc&&!fresh;
  if(!text||text.trim().length<6) return null;
  return(
    <p style={{margin:0,fontSize:11,color:"#7c8fa6",lineHeight:1.6,display:"flex",alignItems:"flex-start",gap:6}}>
      <span style={{flexShrink:0,marginTop:1}}>{fresh?<Tip text="AI-generated summary"><span style={{fontSize:9,color:"#a78bfa",fontWeight:700}}>✦</span></Tip>:generating?<Tip text="Generating AI summary… showing heuristic for now"><span style={{fontSize:9,color:"#475569"}}>◌</span></Tip>:null}</span>
      <span>{text}</span>
    </p>
  );
}

function RoadmapView({rows,allThemes,aiCache,ensureSummary,onRegenAll}){
  const[selSprint,setSelSprint]=useState("all");
  const[collapsed,setCollapsed]=useState(new Set());
  const[collapsedSprints,setCollapsedSprints]=useState(new Set());
  const toggleCollapse=k=>setCollapsed(p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n;});
  const toggleSprint=k=>setCollapsedSprints(p=>{const n=new Set(p);n.has(k)?n.delete(k):n.add(k);return n;});

  const sprintsWithWork=[...new Set(rows.map(r=>sprintNumOf(r.sprint)).filter(n=>n>0))].sort((a,b)=>a-b);
  const sprintDates=n=>fmtDay(sprintStartDate(n))+" – "+fmtDay(new Date(sprintEndDate(n).getTime()-24*60*60*1000));
  const daysRemaining=n=>{const end=sprintEndDate(n);const now=Date.now();if(now>end.getTime())return 0;const start=sprintStartDate(n);if(now<start.getTime())return CFG.lengthDays;return Math.max(0,Math.ceil((end.getTime()-now)/(1000*60*60*24)));};

  const visibleSprints=selSprint==="all"?[...sprintsWithWork]:[sprintNumOf(selSprint)];
  const getTeamData=n=>{
    const s="Sprint "+n;const rs=rows.filter(r=>r.sprint===s);const byTeam={};
    rs.forEach(r=>{const t=r.team||"Unknown";if(!byTeam[t])byTeam[t]={team:t,pts:0,ptsRemaining:0,tickets:[],doneCount:0,byTheme:{}};
      byTeam[t].pts+=(r.points||0);if(!DONE_STATUSES.has(r.status))byTeam[t].ptsRemaining+=(r.points||0);if(DONE_STATUSES.has(r.status))byTeam[t].doneCount++;
      byTeam[t].tickets.push(r);const th=r.theme||"Uncategorised";if(!byTeam[t].byTheme[th])byTeam[t].byTheme[th]={theme:th,pts:0,tickets:[]};byTeam[t].byTheme[th].pts+=(r.points||0);byTeam[t].byTheme[th].tickets.push(r);});
    return sortTeams(Object.keys(byTeam)).map(k=>byTeam[k]).filter(td=>td.tickets.length>0);
  };
  const getSprintStats=n=>{
    const s="Sprint "+n;const rs=rows.filter(r=>r.sprint===s);
    const totalPts=rs.reduce((a,r)=>a+(r.points||0),0);
    const donePts=rs.filter(r=>DONE_STATUSES.has(r.status)).reduce((a,r)=>a+(r.points||0),0);
    const doneCount=rs.filter(r=>DONE_STATUSES.has(r.status)).length;
    const critCount=rs.filter(r=>r.priority===topPriority()).length;
    const teamCount=[...new Set(rs.map(r=>r.team).filter(Boolean))].length;
    return{totalPts,donePts,remainingPts:totalPts-donePts,critCount,doneCount,totalCount:rs.length,teamCount,pct:rs.length>0?Math.round((doneCount/rs.length)*100):0,ptsPct:totalPts>0?Math.round((donePts/totalPts)*100):0};
  };
  const _ms=trackedMilestones(),m1=_ms[0],m2=_ms[1];
  const bD=m1?m1.date:null,gD=m2?m2.date:null;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
      <div style={{background:"linear-gradient(135deg,#0c0a1a 0%,#1a1035 40%,#0c1a2e 100%)",borderRadius:14,padding:"24px 28px",marginBottom:20,border:"1px solid #2d1f6e",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-40,right:-40,width:180,height:180,borderRadius:"50%",background:"radial-gradient(circle,#7c3aed18,transparent)",pointerEvents:"none"}}/>
        <div style={{position:"absolute",bottom:-50,left:20,width:140,height:140,borderRadius:"50%",background:"radial-gradient(circle,#22c55e12,transparent)",pointerEvents:"none"}}/>
        <div style={{position:"relative",display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <span style={{fontSize:26,lineHeight:1}}>{CFG.emoji||"🚀"}</span>
              <div>
                <h2 style={{margin:0,fontSize:20,fontWeight:900,color:"#f1f5f9",letterSpacing:-0.5,lineHeight:1.2}}>{CFG.projectName} Sprint Delivery</h2>
                <p style={{margin:0,fontSize:12,color:"#7c6fb0",fontWeight:500,marginTop:2}}>{CFG.subtitle}</p>
              </div>
            </div>
            <div style={{display:"flex",gap:16,flexWrap:"wrap",marginTop:8,alignItems:"center"}}>
              {trackedMilestones().map(m=>(<span key={m.label} style={{fontSize:12,color:m.color,fontWeight:600}}>{"✦ "+m.label+": "+fmtDate(m.date)}</span>))}
              <span style={{fontSize:12,color:"#94a3b8"}}>{rows.filter(r=>r.sprint!=="TBD").length+" tickets across "+sprintsWithWork.length+" sprints"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            <Tip text="Regenerate all AI summaries from latest descriptions"><button onClick={onRegenAll} style={{padding:"5px 10px",borderRadius:6,border:"1px solid #7c3aed44",background:"#7c3aed18",color:"#a78bfa",fontSize:11,fontWeight:700,cursor:"pointer"}}>✦ Refresh AI</button></Tip>
            <span style={{fontSize:11,color:"#64748b",marginRight:2}}>Filter:</span>
            {[{v:"all",l:"All Sprints"},...sprintsWithWork.map(n=>({v:"Sprint "+n,l:"Sprint "+n}))].map(({v,l})=>{
              const isA=selSprint===v;const n2=v==="all"?null:sprintNumOf(v);const col=n2?sprintCol(n2):"#94a3b8";
              return(<button key={v} onClick={()=>setSelSprint(v)} style={{padding:"5px 12px",borderRadius:6,border:isA?"1px solid "+col:"1px solid #334155",background:isA?col+"33":"transparent",color:isA?col:"#64748b",fontSize:11,fontWeight:isA?700:500,cursor:"pointer"}}>{l}</button>);
            })}
          </div>
        </div>
      </div>

      {visibleSprints.map(n=>{
        const sprintKey="Sprint "+n;const col=sprintCol(n);const act=isActive(n);const stats=getSprintStats(n);const teamData=getTeamData(n);
        const progCol=stats.pct===100?"#22c55e":col;const daysLeft=daysRemaining(n);
        const daysColour=daysLeft<=2?"#ef4444":daysLeft<=5?"#f59e0b":"#4ade80";
        const daysText=daysLeft===0?"Sprint ended":daysLeft===1?"1 day left":daysLeft+" days left";
        const isSprintCollapsed=collapsedSprints.has(sprintKey);
        return(
          <div key={n} style={{marginBottom:28}}>
            <div onClick={()=>toggleSprint(sprintKey)} style={{background:"linear-gradient(90deg,"+col+"18,"+col+"06 70%,transparent)",border:"1px solid "+col+"33",borderRadius:12,padding:"16px 22px",marginBottom:isSprintCollapsed?0:14,position:"relative",overflow:"hidden",cursor:"pointer",userSelect:"none"}}
              onMouseEnter={e=>e.currentTarget.style.background="linear-gradient(90deg,"+col+"25,"+col+"0a 70%,transparent)"}
              onMouseLeave={e=>{e.currentTarget.style.background="linear-gradient(90deg,"+col+"18,"+col+"06 70%,transparent)";}}>
              <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,background:col,borderRadius:"12px 0 0 12px"}}/>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                <div style={{marginLeft:8,flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                    <span style={{fontSize:18,fontWeight:900,color:col,letterSpacing:-0.5}}>{sprintKey}</span>
                    {act&&<span style={{fontSize:10,background:col+"33",color:col,padding:"2px 8px",borderRadius:10,fontWeight:700,letterSpacing:0.5}}>ACTIVE NOW</span>}
                    {!act&&isExpiredAbs(n)&&<span style={{fontSize:10,background:"#22c55e18",color:"#4ade80",padding:"2px 8px",borderRadius:10,fontWeight:600}}>COMPLETED</span>}
                    <span style={{fontSize:12,color:"#64748b"}}>{"📅 "+sprintDates(n)}</span>
                    {act&&<span style={{fontSize:11,fontWeight:700,color:daysColour,background:daysColour+"18",padding:"2px 8px",borderRadius:10}}>{"⏱ "+daysText}</span>}
                  </div>
                  <div style={{display:"flex",gap:20,flexWrap:"wrap",alignItems:"center"}}>
                    <div><span style={{fontSize:18,fontWeight:900,color:"#f1f5f9"}}>{stats.totalPts}</span><span style={{fontSize:11,color:"#64748b",marginLeft:4}}>total pts</span></div>
                    <div><span style={{fontSize:18,fontWeight:900,color:"#22c55e"}}>{stats.donePts}</span><span style={{fontSize:11,color:"#64748b",marginLeft:4}}>pts done</span></div>
                    <div><span style={{fontSize:18,fontWeight:900,color:stats.remainingPts===0?"#22c55e":"#f59e0b"}}>{stats.remainingPts}</span><span style={{fontSize:11,color:"#64748b",marginLeft:4}}>pts remaining</span></div>
                    <div style={{width:1,height:28,background:"#334155"}}/>
                    <span style={{fontSize:13,color:"#94a3b8"}}>{stats.totalCount+" tickets"}</span>
                    <span style={{fontSize:13,color:"#94a3b8"}}>{stats.teamCount+" teams"}</span>
                    {stats.critCount>0&&<span style={{fontSize:12,color:"#f87171"}}>{stats.critCount+" critical"}</span>}
                  </div>
                </div>
                <div style={{textAlign:"right",minWidth:120}}>
                  <span style={{fontSize:26,fontWeight:900,lineHeight:1,color:stats.pct===100?"#22c55e":col}}>{stats.pct+"%"}</span>
                  <div style={{fontSize:10,color:"#64748b",marginBottom:5}}>tickets complete</div>
                  <div style={{width:110,height:5,background:"#0f172a",borderRadius:3,overflow:"hidden",marginBottom:3}}><div style={{height:"100%",width:stats.pct+"%",background:progCol,borderRadius:3,transition:"width 0.3s"}}/></div>
                  <div style={{width:110,height:3,background:"#0f172a",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:stats.ptsPct+"%",background:"#22c55e",borderRadius:2,opacity:0.6}}/></div>
                  <div style={{fontSize:9,color:"#475569",marginTop:2,textAlign:"right"}}>{stats.ptsPct+"% pts done"}</div>
                </div>
                <span style={{fontSize:13,color:"#475569",marginLeft:8,flexShrink:0}}>{isSprintCollapsed?"▼":"▲"}</span>
              </div>
            </div>

            {!isSprintCollapsed&&teamData.length===0&&(<div style={{padding:"20px",color:"#475569",fontSize:13,textAlign:"center",background:"#1e293b",borderRadius:8,border:"1px solid #334155"}}>No tickets assigned yet.</div>)}
            {!isSprintCollapsed&&teamData.map(td=>{
              const tc=teamColor(td.team);const themes=Object.values(td.byTheme).sort((a,b)=>b.pts-a.pts);
              const teamKey=sprintKey+"-"+td.team;const isC=collapsed.has(teamKey);
              const teamPct=td.tickets.length>0?Math.round((td.doneCount/td.tickets.length)*100):0;
              const teamProgCol=teamPct===100?"#22c55e":tc;
              return(
                <div key={td.team} style={{background:"#1e293b",borderRadius:10,border:"1px solid #334155",marginBottom:10,overflow:"hidden"}}>
                  <div onClick={()=>toggleCollapse(teamKey)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 18px",background:tc+"0e",borderBottom:isC?"none":"1px solid "+tc+"1a",cursor:"pointer",userSelect:"none"}}
                    onMouseEnter={e=>e.currentTarget.style.background=tc+"18"} onMouseLeave={e=>{e.currentTarget.style.background=tc+"0e";}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}><div style={{width:6,height:28,borderRadius:3,background:tc,flexShrink:0}}/><span style={{fontSize:15,fontWeight:700,color:tc}}>{teamLabel(td.team)}</span></div>
                    <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                      <div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:800,color:"#f59e0b",lineHeight:1}}>{td.pts}</div><div style={{fontSize:9,color:"#64748b"}}>total pts</div></div>
                      <div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:800,color:td.ptsRemaining===0?"#22c55e":"#f87171",lineHeight:1}}>{td.ptsRemaining}</div><div style={{fontSize:9,color:"#64748b"}}>remaining</div></div>
                      <div style={{textAlign:"center"}}><div style={{fontSize:15,fontWeight:800,color:td.tickets.length===td.doneCount?"#22c55e":"#94a3b8",lineHeight:1}}>{td.doneCount+"/"+td.tickets.length}</div><div style={{fontSize:9,color:"#64748b"}}>tickets</div></div>
                      <div style={{display:"flex",flexDirection:"column",gap:2,alignItems:"flex-end",minWidth:80}}><div style={{fontSize:12,fontWeight:700,color:teamPct===100?"#22c55e":tc}}>{teamPct+"%"}</div><div style={{width:80,height:4,background:"#0f172a",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:teamPct+"%",background:teamProgCol,borderRadius:2}}/></div></div>
                    </div>
                    <span style={{fontSize:12,color:"#475569",marginLeft:8,flexShrink:0}}>{isC?"▼":"▲"}</span>
                  </div>
                  {!isC&&(
                    <div style={{padding:"12px 18px",display:"flex",flexDirection:"column",gap:12}}>
                      {themes.map(thGrp=>{
                        const thCol=allThemes[thGrp.theme]||"#64748b";
                        const doneInTheme=thGrp.tickets.filter(t=>DONE_STATUSES.has(t.status)).length;
                        const pctTh=thGrp.tickets.length>0?Math.round((doneInTheme/thGrp.tickets.length)*100):0;
                        return(
                          <div key={thGrp.theme}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7,paddingBottom:6,borderBottom:"1px solid "+thCol+"22"}}>
                              <span style={{width:8,height:8,borderRadius:"50%",background:thCol,flexShrink:0}}/>
                              <span style={{fontSize:13,fontWeight:700,color:thCol,flex:1}}>{thGrp.theme}</span>
                              <span style={{fontSize:11,color:"#f59e0b",fontWeight:600}}>{thGrp.pts+" pts"}</span>
                              <span style={{fontSize:10,color:"#64748b"}}>{doneInTheme+"/"+thGrp.tickets.length}</span>
                              <div style={{width:60,height:3,background:"#0f172a",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:pctTh+"%",background:pctTh===100?"#22c55e":thCol,borderRadius:2}}/></div>
                              <span style={{fontSize:10,color:pctTh===100?"#22c55e":thCol,fontWeight:600}}>{pctTh+"%"}</span>
                            </div>
                            <div style={{display:"flex",flexDirection:"column",gap:6,paddingLeft:16,borderLeft:"2px solid "+thCol+"33"}}>
                              {thGrp.tickets.map(t=>{
                                const pc=PRIORITY_COL[t.priority]||"#64748b";const sc=STATUS_COL[t.status]||"#64748b";
                                return(
                                  <div key={t._id} style={{background:"#0f172a",borderRadius:7,padding:"9px 12px",borderLeft:"3px solid "+pc+"88",opacity:DONE_STATUSES.has(t.status)?0.65:1}}>
                                    <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                                      <span style={{fontSize:12,fontWeight:600,color:"#e2e8f0",flex:1,minWidth:140,lineHeight:1.4}}>{t.title}</span>
                                      <div style={{display:"flex",gap:5,flexShrink:0,flexWrap:"wrap",alignItems:"center"}}>
                                        <JiraLink id={t.id}/>
                                        {t.points!=null&&<span style={{fontSize:10,color:"#f59e0b",fontWeight:700,background:"rgba(245,158,11,0.12)",padding:"0 5px",borderRadius:3}}>{t.points+"pt"}</span>}
                                        <span style={{fontSize:10,color:sc,background:sc+"18",padding:"1px 6px",borderRadius:3,whiteSpace:"nowrap"}}>{t.status}</span>
                                      </div>
                                    </div>
                                    <AISummary ticket={t} aiCache={aiCache} ensureSummary={ensureSummary}/>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {visibleSprints.length===0&&(<div style={{textAlign:"center",padding:"60px",color:"#475569",fontSize:14}}><div style={{fontSize:40,marginBottom:12}}>🚀</div><div style={{fontSize:15,fontWeight:600,color:"#64748b",marginBottom:6}}>No sprint work yet</div><div style={{fontSize:13}}>Assign tickets to sprints to see the roadmap.</div></div>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FILTER BAR + TOOLS MENU
   ═══════════════════════════════════════════════════════════════════════ */
function FilterBar({filters,setFilters,allThemes,count,pts,activeTeams,sprintOpts}){
  const activePills=[];
  if(filters.team!=="All") activePills.push({k:"team",label:"Team: "+teamLabel(filters.team)});
  if(filters.sprint!=="All") activePills.push({k:"sprint",label:"Sprint: "+filters.sprint});
  if(filters.theme!=="All") activePills.push({k:"theme",label:"Theme: "+filters.theme});
  if(filters.priority!=="All") activePills.push({k:"priority",label:filters.priority});
  if(filters.status!=="All") activePills.push({k:"status",label:filters.status});
  if(filters.newOnly) activePills.push({k:"newOnly",label:"NEW only"});
  if(filters.tbdOnly) activePills.push({k:"tbdOnly",label:"⚠ TBD only"});
  const hasPills=activePills.length>0;
  const Dd=({fkey,opts,placeholder,labelFn})=>{
    const active=!!(filters[fkey]&&filters[fkey]!=="All");
    return(
      <div style={{position:"relative"}}>
        <select value={filters[fkey]||"All"} onChange={e=>setFilters(f=>({...f,[fkey]:e.target.value}))}
          style={{background:"#0f172a",color:active?"#f1f5f9":"#64748b",border:active?"1px solid #3b82f6":"1px solid #334155",borderRadius:6,padding:"5px 26px 5px 10px",fontSize:11,fontWeight:600,cursor:"pointer",outline:"none",appearance:"none",WebkitAppearance:"none"}}>
          <option value="All">{placeholder}</option>
          {opts.map(o=><option key={o} value={o}>{labelFn?labelFn(o):o}</option>)}
        </select>
        <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#64748b",pointerEvents:"none"}}>▼</span>
      </div>
    );
  };
  return(
    <div style={{background:"#1e293b",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <Dd fkey="team" opts={activeTeams.filter(t=>t!=="All")} placeholder="Team" labelFn={teamLabel}/>
        <Dd fkey="sprint" opts={sprintOpts} placeholder="Sprint"/>
        <Dd fkey="theme" opts={Object.keys(allThemes)} placeholder="Theme"/>
        <Dd fkey="priority" opts={PRIORITY_OPTS} placeholder="Priority"/>
        <Dd fkey="status" opts={STATUS_OPTS} placeholder="Status"/>
        <button onClick={()=>setFilters(f=>({...f,newOnly:!f.newOnly}))} style={{padding:"5px 12px",borderRadius:6,border:filters.newOnly?"1px solid #7c3aed":"1px solid #334155",background:filters.newOnly?"rgba(124,58,237,0.2)":"transparent",color:filters.newOnly?"#a78bfa":"#64748b",fontSize:11,fontWeight:600,cursor:"pointer"}}>NEW only</button>
        <button onClick={()=>setFilters(f=>({...f,showDone:!f.showDone}))} style={{padding:"5px 12px",borderRadius:6,border:filters.showDone?"1px solid #22c55e":"1px solid #334155",background:filters.showDone?"rgba(34,197,94,0.1)":"transparent",color:filters.showDone?"#4ade80":"#64748b",fontSize:11,fontWeight:600,cursor:"pointer"}}>{filters.showDone?"Hide Done":"Show Done"}</button>
        <button onClick={()=>setFilters(f=>({...f,tbdOnly:!f.tbdOnly}))} style={{padding:"5px 12px",borderRadius:6,border:filters.tbdOnly?"1px solid #f59e0b":"1px solid #334155",background:filters.tbdOnly?"rgba(245,158,11,0.15)":"transparent",color:filters.tbdOnly?"#fbbf24":"#64748b",fontSize:11,fontWeight:600,cursor:"pointer"}}>⚠ TBD only</button>
        {hasPills&&(<button onClick={()=>setFilters({team:"All",sprint:"All",theme:"All",priority:"All",status:"All",newOnly:false,showDone:false,tbdOnly:false})} style={{padding:"5px 10px",borderRadius:6,border:"1px solid #334155",background:"transparent",color:"#f87171",fontSize:11,cursor:"pointer",marginLeft:"auto"}}>Clear all ✕</button>)}
        <span style={{fontSize:11,color:"#475569",marginLeft:hasPills?"0":"auto"}}>{count} tickets · <strong style={{color:"#f1f5f9"}}>{pts} pts</strong></span>
      </div>
      {hasPills&&(<div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
        {activePills.map(({k,label})=>(<div key={k} style={{display:"flex",alignItems:"center",gap:4,background:"#1e3a5f",border:"1px solid #3b82f6",borderRadius:20,padding:"2px 8px",fontSize:11,color:"#93c5fd"}}><span>{label}</span><button onClick={()=>setFilters(f=>({...f,[k]:k==="newOnly"||k==="tbdOnly"?false:"All"}))} style={{background:"none",border:"none",color:"#60a5fa",cursor:"pointer",fontSize:12,lineHeight:1,padding:0}}>✕</button></div>))}
      </div>)}
    </div>
  );
}
function ToolsMenu({onImport,onExport,onDups,onRollback,onSettings,onRefreshOpen,dupCount}){
  const[open,setOpen]=useState(false);const ref=useRef();
  useEffect(()=>{const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);},[]);
  const MenuItem=({label,icon,onClick,badge})=>(
    <div onClick={()=>{onClick();setOpen(false);}} style={{padding:"8px 14px",cursor:"pointer",fontSize:12,color:"#e2e8f0",display:"flex",alignItems:"center",gap:8,borderRadius:4}}
      onMouseEnter={e=>e.currentTarget.style.background="#334155"} onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
      <span>{icon}</span>{label}{badge>0&&<span style={{background:"#7c3aed",color:"#fff",borderRadius:10,padding:"1px 6px",fontSize:9,marginLeft:"auto"}}>{badge}</span>}
    </div>
  );
  return(
    <div ref={ref} style={{position:"relative"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{padding:"6px 12px",background:"#1e293b",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>⋯ Tools{dupCount>0&&<span style={{background:"#7c3aed",color:"#fff",borderRadius:10,padding:"1px 5px",fontSize:9}}>{dupCount}</span>}</button>
      {open&&(<div style={{position:"absolute",top:"100%",right:0,zIndex:999,background:"#1e293b",border:"1px solid #334155",borderRadius:8,marginTop:4,minWidth:185,boxShadow:"0 8px 24px rgba(0,0,0,0.6)",padding:"4px"}}>
        {onRefreshOpen&&<MenuItem label="Refresh from Jira (open only)" icon="🔄" onClick={onRefreshOpen} badge={0}/>}
        <MenuItem label="Import data" icon="📥" onClick={onImport} badge={0}/>
        <MenuItem label="Export CSV" icon="📤" onClick={onExport} badge={0}/>
        <div style={{height:1,background:"#334155",margin:"4px 0"}}/>
        <MenuItem label="Find Duplicates" icon="🔀" onClick={onDups} badge={dupCount}/>
        <MenuItem label="Roll Back" icon="⏪" onClick={onRollback} badge={0}/>
        <div style={{height:1,background:"#334155",margin:"4px 0"}}/>
        <MenuItem label="Settings" icon="⚙️" onClick={onSettings} badge={0}/>
      </div>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   MODALS — Import (CSV + Connector/JSON), Duplicates, Merge, Settings, Wizard
   ═══════════════════════════════════════════════════════════════════════ */
function ImportModal({onClose,onImport}){
  const[tab,setTab]=useState("file");
  const[dragging,setDragging]=useState(false);
  const[preview,setPreview]=useState(null);
  const[paste,setPaste]=useState("");
  const[json,setJson]=useState("");
  const[error,setError]=useState(null);
  const[upsertOnly,setUpsertOnly]=useState(false);
  const fileRef=useRef();
  const handleFile=file=>{
    if(!file)return;setError(null);setPreview(null);
    const r=new FileReader();
    r.onload=e=>{const text=e.target.result;const recs=csvToRecords(text);setPreview({rawText:text,rowCount:recs.length,name:file.name,ok:recs.length>0});if(recs.length===0)setError("No tickets found — check this is a Jira CSV with an 'Issue key' column.");};
    r.readAsText(file);
  };
  const ready=tab==="file"?(preview!=null&&preview.ok):tab==="text"?paste.trim().length>10:json.trim().length>2;
  const doImport=()=>{
    if(tab==="json"){ const recs=jsonToRecords(json); if(recs.length===0){setError("Couldn't parse any issues from that JSON.");return;} onImport({kind:"records",records:recs,upsertOnly}); }
    else { const t=tab==="file"?(preview&&preview.rawText):paste; if(t) onImport({kind:"csv",text:t,upsertOnly}); }
  };
  return(
    <Overlay>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9"}}>Import data</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{background:"rgba(15,23,42,0.5)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"8px 12px",marginBottom:14,fontSize:12,color:"#fca5a5"}}>
        ⚠️ This source is the source of truth — tickets not present will be <strong>removed</strong>. Priority is protected (kept) unless a team opts into Jira-driven priority in Settings. Descriptions, notes, points & manual edits are preserved.
      </div>
      <div style={{display:"flex",gap:4,marginBottom:14,background:"#0f172a",borderRadius:8,padding:4}}>
        {[["file","CSV File"],["text","Paste CSV"],["json","Connector / JSON"]].map(([k,l])=>(
          <button key={k} onClick={()=>{setTab(k);setError(null);}} style={{flex:1,padding:"6px 0",borderRadius:6,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:tab===k?"#1e293b":"transparent",color:tab===k?"#f1f5f9":"#64748b"}}>{l}</button>
        ))}
      </div>
      {tab==="file"&&(<div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);handleFile(e.dataTransfer.files[0]);}} onClick={()=>fileRef.current.click()} style={{border:dragging?"2px dashed #3b82f6":"2px dashed #334155",borderRadius:10,padding:"20px",textAlign:"center",cursor:"pointer",background:dragging?"rgba(30,58,95,0.3)":"#0f172a",marginBottom:10}}>
        <div style={{fontSize:24,marginBottom:4}}>📂</div><div style={{fontSize:13,color:"#94a3b8"}}>Drop Jira CSV or click to browse</div>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={e=>handleFile(e.target.files[0])} style={{display:"none"}}/>
      </div>)}
      {tab==="file"&&preview&&(<div style={{background:"#0f172a",borderRadius:6,padding:"8px 12px",marginBottom:10,fontSize:12}}><div style={{color:"#f1f5f9",fontWeight:600}}>{preview.name}</div><div style={{color:"#94a3b8"}}>{preview.rowCount} tickets</div>{preview.ok&&<div style={{color:"#22c55e",marginTop:2}}>✓ Jira format detected</div>}</div>)}
      {tab==="text"&&(<textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder={"Paste CSV with header:\nIssue key,Summary,Status,Sprint,...,Description"} style={{width:"100%",height:170,background:"#0f172a",color:"#f1f5f9",border:"1px solid #334155",borderRadius:8,padding:"10px",fontSize:11,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box",marginBottom:4}}/>)}
      {tab==="json"&&(<><div style={{fontSize:11,color:"#64748b",marginBottom:6}}>Paste (or upload a <code>.json</code> file with) the result of your saved Jira filter. Accepts a raw <code>{"{issues:[…]}"}</code> response or a simplified array of <code>{"{id,title,status,sprint,points,team,parentSummary,description,priority}"}</code>.</div>
        <div style={{marginBottom:8}}><input type="file" accept=".json,.txt" onChange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>setJson(ev.target.result);r.readAsText(f);}} style={{fontSize:11,color:"#94a3b8"}}/></div>
        <textarea value={json} onChange={e=>setJson(e.target.value)} placeholder={'[{"id":"WEB-123","title":"…","status":"In Progress","sprint":"2026 Sprint 12","points":5,"team":"PA - ST7","parentSummary":"OBX PERE - Platform","description":"…"}]'} style={{width:"100%",height:170,background:"#0f172a",color:"#f1f5f9",border:"1px solid #334155",borderRadius:8,padding:"10px",fontSize:11,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box",marginBottom:4}}/></>)}
      {error&&<div style={{background:"rgba(69,10,10,0.3)",border:"1px solid rgba(220,38,38,0.3)",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#f87171",marginTop:8}}>{error}</div>}
      <label style={{display:"flex",alignItems:"flex-start",gap:8,marginTop:12,fontSize:12,color:"#e2e8f0",cursor:"pointer"}}>
        <input type="checkbox" checked={upsertOnly} onChange={e=>setUpsertOnly(e.target.checked)} style={{marginTop:2}}/>
        <span><strong>Update only</strong> — add/update tickets in this file but <strong>keep</strong> ones that aren't in it.<br/><span style={{color:"#64748b"}}>Tick this for partial / open-only pulls (e.g. <code>sync:open</code>) so Done tickets aren't removed. Leave unticked for a full sync.</span></span>
      </label>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:14}}>
        <button onClick={onClose} style={{padding:"6px 16px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Cancel</button>
        <button onClick={doImport} disabled={!ready} style={{padding:"6px 16px",background:ready?"#1d4ed8":"#334155",color:ready?"#fff":"#64748b",border:"none",borderRadius:6,cursor:ready?"pointer":"not-allowed",fontSize:13,fontWeight:600}}>{upsertOnly?"Import & Update":"Import & Sync"}</button>
      </div>
    </Overlay>
  );
}
function DuplicatesModal({rows,onClose,onMerge}){
  const pairs=findDuplicates(rows);
  const[dismissed,setDismissed]=useState(new Set());
  const visible=pairs.filter(p=>!dismissed.has(p.a._id+"-"+p.b._id));
  const scoreCol=s=>s>=0.7?"#ef4444":s>=0.5?"#f59e0b":"#60a5fa";
  const scoreLabel=s=>s>=0.7?"High":s>=0.5?"Likely":"Possible";
  return(
    <Overlay wide>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><div style={{fontSize:15,fontWeight:700,color:"#f1f5f9"}}>Potential Duplicates</div><button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:18}}>✕</button></div>
      {visible.length===0?(<div style={{textAlign:"center",padding:"40px",color:"#64748b"}}><div style={{fontSize:28,marginBottom:8}}>🎉</div><div>No duplicates found</div></div>):(
        <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:480,overflowY:"auto"}}>
          {visible.map((pair,i)=>{const c=scoreCol(pair.score);const primary=pickPrimary([pair.a,pair.b]);return(
            <div key={i} style={{background:"#0f172a",border:"1px solid #334155",borderRadius:8,padding:"12px"}}>
              <div style={{marginBottom:8}}><span style={{background:c+"22",border:"1px solid "+c+"44",borderRadius:4,padding:"2px 8px",fontSize:10,fontWeight:700,color:c}}>{scoreLabel(pair.score)} — {Math.round(pair.score*100)}%</span></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                {[pair.a,pair.b].map(t=>{const tc=teamColor(t.team);const isP=t._id===primary._id;return(
                  <div key={t._id} style={{background:"#1e293b",borderRadius:6,padding:"8px",border:"1px solid "+(isP?"#22c55e":tc+"44")}}>
                    <div style={{fontSize:10,color:tc,fontWeight:700,marginBottom:2}}>{teamLabel(t.team)||"?"}{isP&&<span style={{color:"#22c55e",marginLeft:6}}>★ primary</span>}</div>
                    <div style={{fontSize:10,fontFamily:"monospace",color:tc}}>{t.id}</div>
                    <div style={{fontSize:11,color:"#f1f5f9",marginTop:2}}>{t.title}</div>
                  </div>);})}
              </div>
              <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                <button onClick={()=>setDismissed(s=>{const n=new Set(s);n.add(pair.a._id+"-"+pair.b._id);return n;})} style={{padding:"4px 12px",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:5,cursor:"pointer",fontSize:11}}>Dismiss</button>
                <button onClick={()=>onMerge([pair.a,pair.b])} style={{padding:"4px 12px",background:"#7c3aed",color:"#fff",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600}}>Merge</button>
              </div>
            </div>);})}
        </div>)}
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><button onClick={onClose} style={{padding:"6px 16px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Close</button></div>
    </Overlay>
  );
}
function MergeModal({tickets,onClose,onMerge}){
  const primary=pickPrimary(tickets);
  const[fw,setFw]=useState(()=>{const i={};MERGE_FIELDS.forEach(f=>{i[f.key]=primary._id;});return i;});
  const preview=MERGE_FIELDS.reduce((acc,f)=>{const src=tickets.find(t=>t._id===fw[f.key])||primary;acc[f.key]=src[f.key];return acc;},{});
  const dv=v=>(v===null||v===undefined||v==="")?"—":String(v);
  const tcols=["#3b82f6","#a855f7","#f59e0b","#22c55e","#ef4444"];
  return(
    <Overlay wide>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}><div style={{fontSize:15,fontWeight:700,color:"#f1f5f9"}}>Merge Tickets</div><button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:18}}>✕</button></div>
      <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>Primary (by key prefix “{CFG.keyPrefix||"—"}”): <strong style={{color:"#22c55e"}}>{primary.id}</strong>. Click a cell to choose which ticket wins each field.</div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"separate",borderSpacing:"0 2px",fontSize:11}}>
          <thead><tr>
            <th style={{padding:"6px 8px",textAlign:"left",fontSize:9,color:"#475569",fontWeight:600,textTransform:"uppercase",width:70}}>Field</th>
            {tickets.map((t,i)=>{const c=tcols[i%5];return <th key={t._id} style={{padding:"6px 8px",textAlign:"left",background:c+"22",borderBottom:"2px solid "+c,minWidth:130}}><div style={{fontSize:10,fontWeight:700,color:c}}>{t.id}</div></th>;})}
            <th style={{padding:"6px 8px",textAlign:"left",background:"rgba(20,83,45,0.2)",borderBottom:"2px solid #22c55e",minWidth:130}}><div style={{fontSize:10,fontWeight:700,color:"#4ade80"}}>Merged</div></th>
          </tr></thead>
          <tbody>{MERGE_FIELDS.map(f=>(<tr key={f.key}>
            <td style={{padding:"5px 8px",fontSize:10,fontWeight:600,color:"#64748b",background:"#0f172a",whiteSpace:"nowrap"}}>{f.label}</td>
            {tickets.map((t,i)=>{const isW=fw[f.key]===t._id;const c=tcols[i%5];return(<td key={t._id} onClick={()=>setFw(w=>({...w,[f.key]:t._id}))} style={{padding:"5px 8px",cursor:"pointer",background:isW?c+"22":"#1e293b",border:isW?"1px solid "+c:"1px solid transparent",borderRadius:3,verticalAlign:"top"}}><div style={{display:"flex",gap:4}}><span style={{fontSize:11,color:isW?c:"#334155"}}>{isW?"●":"○"}</span><span style={{color:isW?c:"#94a3b8",fontWeight:isW?600:400,wordBreak:"break-word",fontSize:10}}>{dv(t[f.key])}</span></div></td>);})}
            <td style={{padding:"5px 8px",background:"rgba(20,83,45,0.15)",borderLeft:"1px solid #14532d",verticalAlign:"top"}}><span style={{color:"#4ade80",fontSize:10,wordBreak:"break-word"}}>{dv(preview[f.key])}</span></td>
          </tr>))}</tbody>
        </table>
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
        <button onClick={onClose} style={{padding:"6px 16px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Cancel</button>
        <button onClick={()=>onMerge(preview,tickets.map(t=>t._id))} style={{padding:"6px 16px",background:"#166534",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>Merge {tickets.length} tickets</button>
      </div>
    </Overlay>
  );
}

const inputStyle={width:"100%",background:"#0f172a",color:"#f1f5f9",border:"1px solid #334155",borderRadius:6,padding:"7px 9px",fontSize:12,outline:"none",boxSizing:"border-box"};
const labelStyle={fontSize:10,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5,marginBottom:4,display:"block"};
function Field({label,children,hint}){return(<div style={{marginBottom:12}}><label style={labelStyle}>{label}</label>{children}{hint&&<div style={{fontSize:10,color:"#475569",marginTop:3}}>{hint}</div>}</div>);}

function SettingsModal({config,onSave,onClose,discoveredTeams,themeColors}){
  // seed the editable theme list from configured themes ∪ themes in use (so
  // data-discovered themes can be recoloured/removed here too)
  const[d,setD]=useState(()=>JSON.parse(JSON.stringify({...DEFAULT_CONFIG,...config,themes:{...(themeColors||{}),...(config.themes||{})}})));
  const set=(k,v)=>setD(p=>({...p,[k]:v}));
  const teams=sortTeams([...new Set([...(discoveredTeams||[]),...Object.keys(d.teamNames||{}),...Object.keys(d.teamColors||{})])]);
  const setTeamName=(t,v)=>setD(p=>({...p,teamNames:{...p.teamNames,[t]:v}}));
  const setTeamCol=(t,v)=>setD(p=>({...p,teamColors:{...p.teamColors,[t]:v}}));
  const toggleMapTeam=t=>setD(p=>{const s=new Set(p.priorityMapTeams||[]);s.has(t)?s.delete(t):s.add(t);return{...p,priorityMapTeams:[...s]};});
  const setTheme=(name,col)=>setD(p=>({...p,themes:{...p.themes,[name]:col}}));
  const delTheme=name=>setD(p=>{const n={...p.themes};delete n[name];return{...p,themes:n}});
  const[newTheme,setNewTheme]=useState("");
  const setPmap=(jira,our)=>setD(p=>({...p,priorityMap:{...p.priorityMap,[jira]:our}}));
  // statuses
  const setStatus=(i,k,v)=>setD(p=>{const a=[...p.statuses];a[i]={...a[i],[k]:v};return{...p,statuses:a};});
  const addStatus=()=>setD(p=>({...p,statuses:[...(p.statuses||[]),{name:"New status",color:THEME_PALETTE[(p.statuses||[]).length%THEME_PALETTE.length],done:false}]}));
  const delStatus=i=>setD(p=>({...p,statuses:p.statuses.filter((_,j)=>j!==i)}));
  // priority levels (order = rank; top=Beta scope, top-two=GA scope)
  const setPrio=(i,k,v)=>setD(p=>{const a=[...p.priorities];a[i]={...a[i],[k]:v};return{...p,priorities:a};});
  const addPrio=()=>setD(p=>({...p,priorities:[...(p.priorities||[]),{label:"New",color:"#64748b"}]}));
  const delPrio=i=>setD(p=>({...p,priorities:p.priorities.filter((_,j)=>j!==i)}));
  const movePrio=(i,dir)=>setD(p=>{const a=[...p.priorities];const j=i+dir;if(j<0||j>=a.length)return p;[a[i],a[j]]=[a[j],a[i]];return{...p,priorities:a};});
  // milestones
  const setMile=(i,k,v)=>setD(p=>{const a=[...(p.milestones||[])];a[i]={...a[i],[k]:v};return{...p,milestones:a};});
  const addMile=()=>setD(p=>({...p,milestones:[...(p.milestones||[]),{label:"Milestone",date:(p.milestones&&p.milestones.length?p.milestones[p.milestones.length-1].date:p.anchorISO),color:THEME_PALETTE[(p.milestones||[]).length%THEME_PALETTE.length]}]}));
  const delMile=i=>setD(p=>({...p,milestones:(p.milestones||[]).filter((_,j)=>j!==i)}));
  const miniBtn={padding:"2px 7px",background:"#0f172a",color:"#94a3b8",border:"1px solid #334155",borderRadius:5,cursor:"pointer",fontSize:10,lineHeight:1};
  const section={marginBottom:18,paddingBottom:16,borderBottom:"1px solid #334155"};
  const h=t=>(<div style={{fontSize:12,fontWeight:800,color:"#f1f5f9",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>{t}</div>);
  return(
    <Overlay wide>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:16,fontWeight:800,color:"#f1f5f9"}}>⚙️ Settings</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:18}}>✕</button>
      </div>

      <div style={section}>{h("🏷️ Identity")}
        <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:10}}>
          <Field label="Project name"><input style={inputStyle} value={d.projectName} onChange={e=>set("projectName",e.target.value)}/></Field>
          <Field label="Emoji"><input style={inputStyle} value={d.emoji} onChange={e=>set("emoji",e.target.value)}/></Field>
        </div>
        <Field label="Subtitle"><input style={inputStyle} value={d.subtitle} onChange={e=>set("subtitle",e.target.value)}/></Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Field label="Primary key prefix" hint="Used for the NEW-only filter and as the 'primary' ticket when merging."><input style={inputStyle} value={d.keyPrefix} onChange={e=>set("keyPrefix",e.target.value.toUpperCase())}/></Field>
          <Field label="Jira base URL" hint="Optional. Enables clickable ticket links, e.g. https://yourco.atlassian.net"><input style={inputStyle} value={d.jiraBaseUrl} onChange={e=>set("jiraBaseUrl",e.target.value)}/></Field>
        </div>
      </div>

      <div style={section}>{h("📅 Sprint model")}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Field label="Anchor sprint #"><input type="number" style={inputStyle} value={d.anchorNum} onChange={e=>set("anchorNum",parseInt(e.target.value)||1)}/></Field>
          <Field label="Anchor start date"><input type="date" style={inputStyle} value={d.anchorISO} onChange={e=>set("anchorISO",e.target.value)}/></Field>
          <Field label="Sprint length (days)"><input type="number" style={inputStyle} value={d.lengthDays} onChange={e=>set("lengthDays",parseInt(e.target.value)||14)}/></Field>
        </div>
        <Field label="Default team capacity (pts/sprint)"><input type="number" style={{...inputStyle,maxWidth:220}} value={d.defaultTeamCap} onChange={e=>set("defaultTeamCap",parseInt(e.target.value)||36)}/></Field>
        <label style={labelStyle}>Key milestones</label>
        <div style={{fontSize:10,color:"#475569",marginBottom:8}}>Labels, dates &amp; colours are all yours. The Timeline & Roadmap automatically track the <strong>next two upcoming</strong> (1st = top-priority scope, 2nd = top-two scope).</div>
        {(d.milestones||[]).map((m,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <input type="color" value={m.color||"#7c3aed"} onChange={e=>setMile(i,"color",e.target.value)} style={{width:30,height:28,background:"#0f172a",border:"1px solid #334155",borderRadius:6,cursor:"pointer",padding:0}}/>
          <input style={{...inputStyle,flex:1}} value={m.label} onChange={e=>setMile(i,"label",e.target.value)} placeholder="Milestone name"/>
          <input type="date" style={{...inputStyle,width:155}} value={m.date} onChange={e=>setMile(i,"date",e.target.value)}/>
          <span onClick={()=>delMile(i)} style={{cursor:"pointer",color:"#ef4444",fontSize:12}}>✕</span>
        </div>))}
        <button onClick={addMile} style={{padding:"5px 12px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginTop:4}}>+ Add milestone</button>
      </div>

      <div style={section}>{h("👥 Teams")}
        {teams.length===0&&<div style={{fontSize:11,color:"#475569"}}>Teams appear here once data is imported.</div>}
        {teams.map(t=>(<div key={t} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:10,fontFamily:"monospace",color:"#60a5fa",minWidth:54}}>{t}</span>
          <input style={{...inputStyle,flex:1}} placeholder={"Display name (default: "+t+")"} value={(d.teamNames&&d.teamNames[t])||""} onChange={e=>setTeamName(t,e.target.value)}/>
          <input type="color" value={(d.teamColors&&d.teamColors[t])||teamColor(t)} onChange={e=>setTeamCol(t,e.target.value)} style={{width:34,height:30,background:"#0f172a",border:"1px solid #334155",borderRadius:6,cursor:"pointer"}}/>
        </div>))}
      </div>

      <div style={section}>{h("🎨 Themes")}
        <Field label="How themes are assigned on import" hint="Applies on your next import.">
          <select value={d.themeSource} onChange={e=>set("themeSource",e.target.value)} style={{...inputStyle,padding:"6px 9px"}}>
            <option value="epic">From the Jira epic / Parent summary — works for any org (recommended)</option>
            <option value="keyword">Keyword rules (PEI preset)</option>
            <option value="manual">Manual — don't infer; I'll assign themes myself</option>
          </select>
        </Field>
        {d.themeSource==="epic"&&<Field label="Strip prefix from epic names (optional)" hint={'e.g. "OBX PERE -" turns "OBX PERE - Platform" into "Platform"'}><input style={inputStyle} value={d.themeEpicStrip||""} onChange={e=>set("themeEpicStrip",e.target.value)}/></Field>}
        <label style={labelStyle}>Theme list &amp; colours</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
          {Object.entries(d.themes).map(([name,col])=>(<div key={name} style={{display:"flex",alignItems:"center",gap:5,background:"#0f172a",border:"1px solid #334155",borderRadius:6,padding:"4px 7px"}}>
            <input type="color" value={col} onChange={e=>setTheme(name,e.target.value)} style={{width:20,height:20,background:"none",border:"none",cursor:"pointer",padding:0}}/>
            <span style={{fontSize:11,color:"#e2e8f0"}}>{name}</span>
            <span onClick={()=>delTheme(name)} style={{cursor:"pointer",color:"#ef4444",fontSize:11,marginLeft:2}}>✕</span>
          </div>))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <input style={{...inputStyle,flex:1}} placeholder="New theme name" value={newTheme} onChange={e=>setNewTheme(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newTheme.trim()){setTheme(newTheme.trim(),THEME_PALETTE[Object.keys(d.themes).length%THEME_PALETTE.length]);setNewTheme("");}}}/>
          <button onClick={()=>{if(newTheme.trim()){setTheme(newTheme.trim(),THEME_PALETTE[Object.keys(d.themes).length%THEME_PALETTE.length]);setNewTheme("");}}} style={{padding:"0 14px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>Add</button>
        </div>
      </div>

      <div style={section}>{h("🧭 Statuses (workflow)")}
        <div style={{fontSize:10,color:"#475569",marginBottom:8}}>Your workflow's statuses, colours, and which ones count as <strong>Done</strong> (hidden by default; excluded from open/remaining). Imported statuses match by name (case-insensitive); unknown ones are kept as-is so nothing is lost.</div>
        {(d.statuses||[]).map((s,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <input type="color" value={s.color} onChange={e=>setStatus(i,"color",e.target.value)} style={{width:30,height:28,background:"#0f172a",border:"1px solid #334155",borderRadius:6,cursor:"pointer",padding:0}}/>
          <input style={{...inputStyle,flex:1}} value={s.name} onChange={e=>setStatus(i,"name",e.target.value)}/>
          <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}><input type="checkbox" checked={!!s.done} onChange={e=>setStatus(i,"done",e.target.checked)}/>Done</label>
          <span onClick={()=>delStatus(i)} style={{cursor:"pointer",color:"#ef4444",fontSize:12}}>✕</span>
        </div>))}
        <button onClick={addStatus} style={{padding:"5px 12px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginTop:4}}>+ Add status</button>
      </div>

      <div style={section}>{h("🎚️ Priority levels")}
        <div style={{fontSize:10,color:"#475569",marginBottom:8}}>Order = rank (sorting follows it). In the Timeline, the top level is the 1st tracked milestone's scope and the top two cover the 2nd. Relabel/recolour freely — emoji allowed.</div>
        {(d.priorities||[]).map((p,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:9,color:i===0?((d.milestones&&d.milestones[0]&&d.milestones[0].color)||"#a78bfa"):i===1?((d.milestones&&d.milestones[1]&&d.milestones[1].color)||"#38bdf8"):"#475569",width:54,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{i===0?((d.milestones&&d.milestones[0]&&d.milestones[0].label)||"M1"):i===1?((d.milestones&&d.milestones[1]&&d.milestones[1].label)||"M2"):"#"+(i+1)}</span>
          <input type="color" value={p.color} onChange={e=>setPrio(i,"color",e.target.value)} style={{width:30,height:28,background:"#0f172a",border:"1px solid #334155",borderRadius:6,cursor:"pointer",padding:0}}/>
          <input style={{...inputStyle,flex:1}} value={p.label} onChange={e=>setPrio(i,"label",e.target.value)}/>
          <button onClick={()=>movePrio(i,-1)} disabled={i===0} style={{...miniBtn,opacity:i===0?0.3:1}}>▲</button>
          <button onClick={()=>movePrio(i,1)} disabled={i===(d.priorities.length-1)} style={{...miniBtn,opacity:i===(d.priorities.length-1)?0.3:1}}>▼</button>
          <span onClick={()=>delPrio(i)} style={{cursor:"pointer",color:"#ef4444",fontSize:12}}>✕</span>
        </div>))}
        <button onClick={addPrio} style={{padding:"5px 12px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginTop:4}}>+ Add level</button>
      </div>

      <div style={{marginBottom:6}}>{h("🔒 Priority")}
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#e2e8f0",marginBottom:10,cursor:"pointer"}}>
          <input type="checkbox" checked={d.protectPriority} onChange={e=>set("protectPriority",e.target.checked)}/>
          Protect priority on import (🔒 never overwritten) — uncheck to let Jira drive it globally
        </label>
        <Field label="Per-team unlock" hint="Teams here let imported Jira priority overwrite ours (using the mapping below).">
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {teams.length===0&&<span style={{fontSize:11,color:"#475569"}}>No teams yet.</span>}
            {teams.map(t=>{const on=(d.priorityMapTeams||[]).includes(t);return(<button key={t} onClick={()=>toggleMapTeam(t)} style={{padding:"3px 10px",borderRadius:10,border:on?"1px solid #22c55e":"1px solid #334155",background:on?"rgba(34,197,94,0.15)":"transparent",color:on?"#4ade80":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>{teamLabel(t)} {on?"✓":""}</button>);})}
          </div>
        </Field>
        <Field label="Jira → our priority mapping">
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {Object.keys(d.priorityMap).map(jira=>(<div key={jira} style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11,color:"#94a3b8",minWidth:64}}>{jira}</span><span style={{color:"#475569"}}>→</span>
              <select value={d.priorityMap[jira]} onChange={e=>setPmap(jira,e.target.value)} style={{...inputStyle,flex:1,padding:"5px 8px"}}>{PRIORITY_OPTS.map(o=><option key={o} value={o}>{o}</option>)}</select>
            </div>))}
          </div>
        </Field>
      </div>

      <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16,position:"sticky",bottom:-24,background:"#1e293b",paddingTop:12,borderTop:"1px solid #334155"}}>
        <button onClick={onClose} style={{padding:"7px 16px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Cancel</button>
        <button onClick={()=>onSave(d)} style={{padding:"7px 18px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>Save settings</button>
      </div>
    </Overlay>
  );
}

function SetupWizard({onComplete,onSkip}){
  const[step,setStep]=useState(0);
  const[d,setD]=useState({...DEFAULT_CONFIG,themes:{}});
  const[wzTheme,setWzTheme]=useState("");
  const set=(k,v)=>setD(p=>({...p,[k]:v}));
  const addWzTheme=()=>{const n=wzTheme.trim();if(!n)return;setD(p=>({...p,themes:{...p.themes,[n]:THEME_PALETTE[Object.keys(p.themes).length%THEME_PALETTE.length]}}));setWzTheme("");};
  const setMile=(i,k,v)=>setD(p=>{const a=[...(p.milestones||[])];a[i]={...a[i],[k]:v};return{...p,milestones:a};});
  const addMile=()=>setD(p=>({...p,milestones:[...(p.milestones||[]),{label:"Milestone",date:(p.milestones&&p.milestones.length?p.milestones[p.milestones.length-1].date:p.anchorISO),color:THEME_PALETTE[(p.milestones||[]).length%THEME_PALETTE.length]}]}));
  const delMile=i=>setD(p=>({...p,milestones:(p.milestones||[]).filter((_,j)=>j!==i)}));
  const steps=["Identity","Sprint model","Themes"];
  return(
    <Overlay>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
        <span style={{fontSize:24}}>{d.emoji||"🚀"}</span>
        <div><div style={{fontSize:16,fontWeight:800,color:"#f1f5f9"}}>Welcome — let's set up your roadmap</div><div style={{fontSize:11,color:"#64748b"}}>Step {step+1} of {steps.length}: {steps[step]}</div></div>
      </div>
      <div style={{display:"flex",gap:4,marginBottom:16}}>{steps.map((s,i)=>(<div key={s} style={{flex:1,height:3,borderRadius:2,background:i<=step?"#7c3aed":"#334155"}}/>))}</div>

      {step===0&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:10}}>
          <Field label="Project name"><input style={inputStyle} autoFocus value={d.projectName} onChange={e=>set("projectName",e.target.value)}/></Field>
          <Field label="Emoji"><input style={inputStyle} value={d.emoji} onChange={e=>set("emoji",e.target.value)}/></Field>
        </div>
        <Field label="Subtitle"><input style={inputStyle} value={d.subtitle} onChange={e=>set("subtitle",e.target.value)}/></Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Field label="Primary key prefix" hint="Your main project key, e.g. WEB"><input style={inputStyle} value={d.keyPrefix} onChange={e=>set("keyPrefix",e.target.value.toUpperCase())}/></Field>
          <Field label="Jira base URL (optional)" hint="Enables clickable ticket links"><input style={inputStyle} value={d.jiraBaseUrl} onChange={e=>set("jiraBaseUrl",e.target.value)}/></Field>
        </div>
        <div style={{fontSize:11,color:"#475569",marginTop:4}}>Teams and themes are auto-discovered from your first import — you can rename them later in Settings.</div>
      </div>)}

      {step===1&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Field label="Anchor sprint #" hint="Any known sprint"><input type="number" style={inputStyle} value={d.anchorNum} onChange={e=>set("anchorNum",parseInt(e.target.value)||1)}/></Field>
          <Field label="…starts on"><input type="date" style={inputStyle} value={d.anchorISO} onChange={e=>set("anchorISO",e.target.value)}/></Field>
          <Field label="Sprint length (days)"><input type="number" style={inputStyle} value={d.lengthDays} onChange={e=>set("lengthDays",parseInt(e.target.value)||14)}/></Field>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Field label="Team capacity (pts/sprint)"><input type="number" style={inputStyle} value={d.defaultTeamCap} onChange={e=>set("defaultTeamCap",parseInt(e.target.value)||36)}/></Field>
        </div>
        <label style={labelStyle}>Key milestones to track against</label>
        <div style={{fontSize:10,color:"#475569",marginBottom:8}}>Name them whatever fits (Beta, GA, Launch, Q3 cut…). The Timeline & Roadmap show the next two upcoming automatically.</div>
        {(d.milestones||[]).map((m,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <input type="color" value={m.color||"#7c3aed"} onChange={e=>setMile(i,"color",e.target.value)} style={{width:30,height:28,background:"#0f172a",border:"1px solid #334155",borderRadius:6,cursor:"pointer",padding:0}}/>
          <input style={{...inputStyle,flex:1}} value={m.label} onChange={e=>setMile(i,"label",e.target.value)} placeholder="Milestone name"/>
          <input type="date" style={{...inputStyle,width:155}} value={m.date} onChange={e=>setMile(i,"date",e.target.value)}/>
          <span onClick={()=>delMile(i)} style={{cursor:"pointer",color:"#ef4444",fontSize:12}}>✕</span>
        </div>))}
        <button onClick={addMile} style={{padding:"5px 12px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginTop:4}}>+ Add milestone</button>
      </div>)}

      {step===2&&(<div>
        <Field label="How should themes be assigned from imported data?" hint="You can change this later in Settings.">
          <select value={d.themeSource} onChange={e=>set("themeSource",e.target.value)} style={{...inputStyle,padding:"6px 9px"}}>
            <option value="epic">From the Jira epic / Parent summary — works for any org (recommended)</option>
            <option value="keyword">Keyword rules (PEI preset)</option>
            <option value="manual">Manual — don't infer; I'll assign themes myself</option>
          </select>
        </Field>
        {d.themeSource==="epic"&&<Field label="Strip prefix from epic names (optional)" hint={'e.g. "OBX PERE -" turns "OBX PERE - Platform" into "Platform"'}><input style={inputStyle} value={d.themeEpicStrip||""} onChange={e=>set("themeEpicStrip",e.target.value)}/></Field>}
        <div style={{fontSize:11,color:"#64748b",marginBottom:12,lineHeight:1.5}}>Optionally pre-add themes below — or leave empty. Themes also appear automatically from imported data, and you can add or recolour them anytime in Settings or from any ticket's Theme dropdown.</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
          {Object.entries(d.themes).map(([name,col])=>(<div key={name} style={{display:"flex",alignItems:"center",gap:5,background:"#0f172a",border:"1px solid #334155",borderRadius:6,padding:"4px 7px"}}>
            <input type="color" value={col} onChange={e=>setD(p=>({...p,themes:{...p.themes,[name]:e.target.value}}))} style={{width:20,height:20,background:"none",border:"none",cursor:"pointer",padding:0}}/>
            <span style={{fontSize:11,color:"#e2e8f0"}}>{name}</span>
            <span onClick={()=>setD(p=>{const n={...p.themes};delete n[name];return{...p,themes:n};})} style={{cursor:"pointer",color:"#ef4444",fontSize:11,marginLeft:2}}>✕</span>
          </div>))}
          {Object.keys(d.themes).length===0&&<span style={{fontSize:11,color:"#475569"}}>No themes yet — add some below, or leave empty and let imports populate them.</span>}
        </div>
        <div style={{display:"flex",gap:8}}>
          <input style={{...inputStyle,flex:1}} placeholder="Theme name (e.g. Onboarding, Billing, Search)" value={wzTheme} onChange={e=>setWzTheme(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addWzTheme();}}/>
          <button onClick={addWzTheme} style={{padding:"0 14px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>Add</button>
        </div>
      </div>)}

      <div style={{display:"flex",gap:10,justifyContent:"space-between",marginTop:16}}>
        <button onClick={onSkip} style={{padding:"7px 14px",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:12}}>Skip — just import</button>
        <div style={{display:"flex",gap:8}}>
          {step>0&&<button onClick={()=>setStep(step-1)} style={{padding:"7px 14px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:12}}>Back</button>}
          {step<steps.length-1
            ?<button onClick={()=>setStep(step+1)} style={{padding:"7px 18px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>Next</button>
            :<button onClick={()=>onComplete({...d,setupComplete:true})} style={{padding:"7px 18px",background:"#7c3aed",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>Finish & import</button>}
        </div>
      </div>
    </Overlay>
  );
}

function EmptyState({onImport,onSetup}){
  return(
    <div style={{textAlign:"center",padding:"80px 40px",color:"#475569"}}>
      <div style={{fontSize:40,marginBottom:16}}>{CFG.emoji||"📋"}</div>
      <div style={{fontSize:18,fontWeight:700,color:"#94a3b8",marginBottom:8}}>No tickets yet</div>
      <div style={{fontSize:13,color:"#475569",marginBottom:24,maxWidth:440,margin:"0 auto 24px"}}>Import a Jira CSV export (or paste a connector pull) to populate the backlog. The import is the source of truth — tickets sync on every re-import; your edits, notes & priorities are preserved.</div>
      <div style={{display:"flex",gap:10,justifyContent:"center"}}>
        <button onClick={onImport} style={{padding:"10px 24px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600}}>📥 Import data</button>
        <button onClick={onSetup} style={{padding:"10px 24px",background:"transparent",color:"#a78bfa",border:"1px solid #7c3aed55",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600}}>⚙️ Run setup wizard</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════════ */
export default function App(){
  const[view,setView]=useState("backlog");
  const[rows,setRows]=useState(null);
  const[config,setConfig]=useState(DEFAULT_CONFIG);
  const[configLoaded,setConfigLoaded]=useState(false);
  const[teamCapacity,setTeamCapacity]=useState({});
  const[aiCache,setAiCache]=useState({});
  const[filters,setFilters]=useState({team:"All",sprint:"All",theme:"All",priority:"All",status:"All",newOnly:false,showDone:false,tbdOnly:false});
  const[showAllSprints,setShowAllSprints]=useState(false);
  const[sortCol,setSortCol]=useState(null);
  const[sortDir,setSortDir]=useState("asc");
  const[saveStatus,setSaveStatus]=useState("idle");
  const[lastSaved,setLastSaved]=useState(null);
  const[resetOpen,setResetOpen]=useState(false);
  const[resetConfirm,setResetConfirm]=useState(false);
  const[resetWindow,setResetWindow]=useState(HOUR_OPTS[0]);
  const[resetText,setResetText]=useState("");
  const[deleteTarget,setDeleteTarget]=useState(null);
  const[importOpen,setImportOpen]=useState(false);
  const[jiraBusy,setJiraBusy]=useState(false);
  const[mergeOpen,setMergeOpen]=useState(false);
  const[dupsOpen,setDupsOpen]=useState(false);
  const[settingsOpen,setSettingsOpen]=useState(false);
  const[wizardOpen,setWizardOpen]=useState(false);
  const[selected,setSelected]=useState(new Set());
  const[toast,setToast]=useState(null);
  const[mergeCandidates,setMergeCandidates]=useState(null);
  const saveTimer=useRef(null);
  const aiCacheRef=useRef({});
  const inflight=useRef(new Set());

  // themes = configured themes ∪ themes present in data, each coloured
  const allThemes=buildThemeMap(rows);

  // ── config persistence ──
  const persistConfig=useCallback(async next=>{ try{ await window.storage.set(CONFIG_KEY,JSON.stringify(next),true); }catch(e){} },[]);
  const saveConfig=useCallback((next)=>{ applyConfig(next); setConfig(next); persistConfig(next); },[persistConfig]);

  useEffect(()=>{(async()=>{
    try{ const r=await window.storage.get(CONFIG_KEY,true); const c={...DEFAULT_CONFIG,...JSON.parse(r.value)}; applyConfig(c); setConfig(c); }
    catch(e){ applyConfig(DEFAULT_CONFIG); }
    setConfigLoaded(true);
  })();},[]);

  useEffect(()=>{(async()=>{try{const r=await window.storage.get(TEAM_CAP_KEY,true);setTeamCapacity(JSON.parse(r.value));}catch(e){}})();},[]);
  useEffect(()=>{(async()=>{try{const r=await window.storage.get(AI_CACHE_KEY,true);const c=JSON.parse(r.value);setAiCache(c);aiCacheRef.current=c;}catch(e){}})();},[]);
  useEffect(()=>{aiCacheRef.current=aiCache;},[aiCache]);

  const updateTeamCapacity=async(sprint,team,val)=>{const key=sprint+":"+team;const next={...teamCapacity,[key]:val};setTeamCapacity(next);try{await window.storage.set(TEAM_CAP_KEY,JSON.stringify(next),true);}catch(e){}};

  // ── AI summary cache ──
  const persistAiCache=useCallback(async next=>{ try{ await window.storage.set(AI_CACHE_KEY,JSON.stringify(next),true); }catch(e){} },[]);
  const ensureSummary=useCallback(async(t,force)=>{
    const desc=(t.desc||"").trim(); if(!desc) return;
    const hsh=hashStr(desc);
    const cur=aiCacheRef.current[t.id];
    if(!force && cur && cur.hash===hsh && cur.text) return;
    if(inflight.current.has(t.id)) return;
    inflight.current.add(t.id);
    try{
      const text=await fetchAISummary(t);
      setAiCache(prev=>{const next={...prev,[t.id]:{hash:hsh,text}};aiCacheRef.current=next;persistAiCache(next);return next;});
    }catch(e){/* graceful — heuristic fallback already shown */}
    finally{ inflight.current.delete(t.id); }
  },[persistAiCache]);
  const regenAll=()=>{ (rows||[]).filter(r=>(r.desc||"").trim()).forEach(r=>ensureSummary(r,true)); setToast("Regenerating AI summaries…"); };

  // ── derived ──
  const activeTeams=rows?["All",...sortTeams([...new Set(rows.map(r=>r.team).filter(Boolean))])]:["All"];
  const allSprintNums=[...new Set((rows||[]).map(r=>sprintNumOf(r.sprint)).filter(n=>n>0))].sort((a,b)=>a-b);
  const curSprint=currentSprintNum();
  const visibleSprintNums=showAllSprints?allSprintNums:allSprintNums.filter(n=>n>=curSprint||!isExpiredAbs(n)).slice(0,7);
  const visibleSprints=visibleSprintNums.map(n=>"Sprint "+n);
  const sprintOpts=[...new Set((rows||[]).map(r=>r.sprint).filter(s=>s&&s!=="TBD"))].sort((a,b)=>sprintNumOf(a)-sprintNumOf(b)).concat(["TBD"]);
  const activeSprint=curSprint;

  // ── styles injected once ──
  useEffect(()=>{
    const s=document.createElement("style");
    s.textContent="input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}select option{background:#1e293b;color:#f1f5f9;}::-webkit-scrollbar{width:6px;height:6px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:4px;}::-webkit-scrollbar-thumb:hover{background:#2d5a8e;}::-webkit-scrollbar-corner{background:transparent;}";
    document.head.appendChild(s);return()=>document.head.removeChild(s);
  },[]);

  // ── rows persistence ──
  const saveHistory=useCallback(async data=>{
    try{ let h=[]; try{const r=await window.storage.get(HISTORY_KEY,true);h=JSON.parse(r.value);}catch(e){}
      h.push({ts:Date.now(),rows:data.map(r=>{const c={...r};delete c._id;return c;})});
      if(h.length>MAX_HISTORY)h=h.slice(-MAX_HISTORY);
      await window.storage.set(HISTORY_KEY,JSON.stringify(h),true);
    }catch(e){}
  },[]);
  const persistRows=useCallback(async data=>{
    setSaveStatus("saving");
    try{
      await window.storage.set(STORAGE_KEY,JSON.stringify(data.map(r=>{const c={...r};delete c._id;return c;})),true);
      await saveHistory(data);
      setSaveStatus("saved");setLastSaved(new Date());
      clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>setSaveStatus("idle"),3000);
    }catch(e){setSaveStatus("idle");}
  },[saveHistory]);

  useEffect(()=>{(async()=>{
    try{ const res=await window.storage.get(STORAGE_KEY,true);
      const stored=JSON.parse(res.value).map((r,i)=>({...r,_id:i+Date.now(),sprint:normaliseSprint(r.sprint||"TBD")}));
      setRows(stored);
    }catch(e){ setRows([]); }
  })();},[]);

  useEffect(()=>{
    if(rows===null||rows.length===0)return;
    clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>persistRows(rows),800);
    return()=>clearTimeout(saveTimer.current);
  },[rows,persistRows]);

  // first-run: wizard if config never completed and no data
  useEffect(()=>{
    if(configLoaded && rows!==null && rows.length===0 && !config.setupComplete && !wizardOpen && !importOpen){
      setWizardOpen(true);
    }
  },[configLoaded,rows]); // eslint-disable-line

  // ── mutations ──
  const update=(id,field,val)=>setRows(rs=>rs.map(r=>{
    if(r._id!==id)return r;
    const nv=field==="points"?(val===""||val===null?null:(parseInt(val)>=0?parseInt(val):null)):val;
    if(field==="theme")return{...r,[field]:nv,_themeOverride:true};
    if(field==="desc")return{...r,[field]:nv,_descOverride:true};
    return{...r,[field]:nv};
  }));
  const addRow=()=>setRows(rs=>[...rs,{_id:Date.now(),id:"NEW-"+(rs.length+1),team:"",title:"New ticket",desc:"",theme:"Uncategorised",priority:defaultPriority(),sprint:"TBD",points:null,status:STATUS_OPTS[0]||"To Do",notes:""}]);
  const doDelete=()=>{setRows(rs=>rs.filter(r=>r._id!==deleteTarget));setDeleteTarget(null);};
  const toggleSelect=id=>setSelected(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;});
  const handleMerge=(merged,ids)=>{setRows(rs=>[...rs.filter(r=>!ids.includes(r._id)),{...merged,_id:Date.now()}]);setMergeOpen(false);setDupsOpen(false);setMergeCandidates(null);setSelected(new Set());setToast(ids.length+" tickets merged");};
  const markAllCritical=()=>{setRows(rs=>rs.map(r=>DONE_STATUSES.has(r.status)?r:{...r,priority:topPriority()}));setToast("All open tickets set to "+topPriority()+" — adjust individually as needed");};

  const runImport=(payload)=>{
    const records=payload.kind==="csv"?csvToRecords(payload.text):payload.records;
    const result=normaliseTickets(records,rows||[],{upsertOnly:payload.upsertOnly});
    if(result.added===0&&result.updated===0&&result.rows.length===0){ setToast("Import found no rows — check the source has an 'Issue key' column"); return; }
    const withIds=result.rows.map((r,i)=>({...r,_id:r._id||(Date.now()+i)}));
    setRows(withIds);
    result.discoveredTeams.forEach(t=>teamColor(t));
    setToast("Import complete — "+result.added+" added, "+result.updated+" updated"+(payload.upsertOnly?" (update only, none removed)":", "+result.removed+" removed")+"."+(result.discoveredTeams.length?" Teams: "+result.discoveredTeams.join(", "):""));
  };
  const handleImport=async payload=>{ setImportOpen(false); runImport(payload); };

  // One-click live refresh via the dev-server endpoint (/api/jira-pull).
  const refreshFromJira=async(open)=>{
    setJiraBusy(true); setToast(open?"Pulling open tickets from Jira…":"Pulling from Jira…");
    try{
      const res=await fetch("/api/jira-pull"+(open?"?open=1":""));
      const data=await res.json().catch(()=>null);
      if(!res.ok) throw new Error((data&&data.error)||("HTTP "+res.status));
      if(!Array.isArray(data)||data.length===0){ setToast("Jira returned 0 tickets — check .jira-credentials.json or the JQL in jira-sync.mjs."); return; }
      runImport({kind:"records",records:data,upsertOnly:!!open});
    }catch(e){
      setToast("Jira refresh failed: "+(e&&e.message||e)+" — make sure the app is running via 'npm run dev', or use Import → Connector/JSON file.");
    }finally{ setJiraBusy(false); }
  };

  const openReset=()=>{setResetText("");setResetConfirm(false);setResetOpen(true);};
  const doReset=async()=>{
    const cutoff=Date.now()-HOUR_MS[HOUR_OPTS.indexOf(resetWindow)];
    try{ let h=[]; try{const r=await window.storage.get(HISTORY_KEY,true);h=JSON.parse(r.value);}catch(e){}
      const before=h.filter(x=>x.ts<=cutoff);
      const snap=before.length?before[before.length-1]:(h.length?h[0]:null);
      setRows(snap?snap.rows.map((r,i)=>({...r,_id:i+Date.now()})):[]);
    }catch(e){setRows([]);}
    setResetOpen(false);setResetConfirm(false);setResetText("");
  };

  const filtered=!rows?[]:rows.filter(r=>{
    if(!filters.showDone&&DONE_STATUSES.has(r.status))return false;
    if(filters.team!=="All"&&r.team!==filters.team)return false;
    if(filters.sprint!=="All"&&r.sprint!==filters.sprint)return false;
    if(filters.theme!=="All"&&r.theme!==filters.theme)return false;
    if(filters.priority!=="All"&&r.priority!==filters.priority)return false;
    if(filters.status!=="All"&&r.status!==filters.status)return false;
    if(filters.newOnly&&CFG.keyPrefix&&r.id.startsWith(CFG.keyPrefix))return false;
    if(filters.tbdOnly&&r.points!==null)return false;
    return true;
  });
  const sorted=sortRows(filtered,sortCol,sortDir,sprintOpts);
  const handleColSort=col=>{if(sortCol===col){if(sortDir==="asc")setSortDir("desc");else{setSortCol(null);setSortDir("asc");}}else{setSortCol(col);setSortDir("asc");}};
  const thBtn=col=>({background:"none",border:"none",cursor:"pointer",padding:"7px 8px",textAlign:col==="points"?"center":"left",fontSize:9,fontWeight:600,color:sortCol===col?"#93c5fd":"#475569",textTransform:"uppercase",letterSpacing:0.5,whiteSpace:"nowrap",width:"100%",display:"flex",alignItems:"center",gap:2,justifyContent:col==="points"?"center":"flex-start"});

  const effectiveMerge=mergeCandidates||(rows?rows.filter(r=>selected.has(r._id)):[]);
  const dupCount=rows&&rows.length>0?findDuplicates(rows).length:0;
  const discoveredTeams=rows?sortTeams([...new Set(rows.map(r=>r.team).filter(Boolean))]):[];
  const savedTime=lastSaved?lastSaved.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"";
  const saveCfg={saving:{bg:"#1e3a5f",color:"#60a5fa",text:"Saving…"},saved:{bg:"rgba(20,83,45,0.3)",color:"#22c55e",text:"Saved "+savedTime},error:{bg:"rgba(69,10,10,0.3)",color:"#f87171",text:"Save failed"},idle:{bg:"#1e293b",color:"#475569",text:"Auto-save on"}}[saveStatus]||{bg:"#1e293b",color:"#475569",text:"Auto-save on"};

  if(rows===null||!configLoaded) return(
    <div style={{background:"#0f172a",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Inter,system-ui,sans-serif"}}>
      <div style={{textAlign:"center",color:"#94a3b8"}}><div style={{fontSize:28,marginBottom:8}}>⏳</div><div>Loading…</div></div>
    </div>
  );

  const sideViews=view==="timeline"||view==="roadmap";
  return(
    <div style={{fontFamily:"Inter,system-ui,sans-serif",background:"#0f172a",minHeight:"100vh",padding:"20px",color:"#e2e8f0"}}>
      <div style={{maxWidth:1800,margin:"0 auto"}}>
        {toast&&<Toast msg={toast} onClose={()=>setToast(null)}/>}
        {importOpen&&<ImportModal onClose={()=>setImportOpen(false)} onImport={handleImport}/>}
        {wizardOpen&&<SetupWizard onComplete={c=>{saveConfig(c);setWizardOpen(false);setImportOpen(true);}} onSkip={()=>{saveConfig({...config,setupComplete:true});setWizardOpen(false);setImportOpen(true);}}/>}
        {settingsOpen&&<SettingsModal config={config} discoveredTeams={discoveredTeams} themeColors={allThemes} onClose={()=>setSettingsOpen(false)} onSave={c=>{
          // auto-remap renamed priority/status labels on existing tickets (by position;
          // only when count is unchanged so it's an unambiguous rename, not add/remove)
          const remap=(oldArr,newArr)=>{if(!oldArr||!newArr||oldArr.length!==newArr.length)return null;const m={};let changed=false;oldArr.forEach((o,i)=>{if(o!==newArr[i]){m[o]=newArr[i];changed=true;}});return changed?m:null;};
          const pm=remap((config.priorities||[]).map(p=>p.label),(c.priorities||[]).map(p=>p.label));
          const sm=remap((config.statuses||[]).map(s=>s.name),(c.statuses||[]).map(s=>s.name));
          if(pm||sm) setRows(rs=>rs?rs.map(r=>({...r,priority:(pm&&pm[r.priority])||r.priority,status:(sm&&sm[r.status])||r.status})):rs);
          saveConfig(c);setSettingsOpen(false);setToast("Settings saved"+((pm||sm)?" — relabelled tickets updated":""));
        }}/>}
        {mergeOpen&&effectiveMerge.length>=2&&<MergeModal tickets={effectiveMerge} onClose={()=>{setMergeOpen(false);setMergeCandidates(null);}} onMerge={handleMerge}/>}
        {dupsOpen&&rows&&<DuplicatesModal rows={rows} onClose={()=>setDupsOpen(false)} onMerge={t=>{setMergeCandidates(t);setDupsOpen(false);setMergeOpen(true);}}/>}

        {deleteTarget!==null&&(()=>{const tkt=rows.find(r=>r._id===deleteTarget);return(
          <Overlay>
            <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>Delete this ticket?</div>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:6}}><strong style={{color:"#f1f5f9"}}>{tkt?.title}</strong></div>
            <div style={{fontSize:12,color:"#64748b",marginBottom:20}}>Note: next import will re-add it if still in the source.</div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setDeleteTarget(null)} style={{padding:"6px 16px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Cancel</button>
              <button onClick={doDelete} style={{padding:"6px 16px",background:"#dc2626",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>Delete</button>
            </div>
          </Overlay>);})()}

        {resetOpen&&!resetConfirm&&(
          <Overlay>
            <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Roll back backlog</div>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:14}}>Select how far back to restore.</div>
            <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:14}}>
              {HOUR_OPTS.map(o=>{const sel=resetWindow===o;return(<div key={o} onClick={()=>setResetWindow(o)} style={{padding:"8px 12px",borderRadius:7,cursor:"pointer",fontSize:13,border:sel?"1px solid #f59e0b":"1px solid #334155",background:sel?"rgba(245,158,11,0.15)":"#0f172a",color:sel?"#fbbf24":"#94a3b8",fontWeight:sel?600:400}}>{o}</div>);})}
            </div>
            <div style={{background:"#0f172a",borderRadius:6,padding:"8px 12px",marginBottom:18,fontSize:12,color:"#f59e0b",borderLeft:"3px solid #f59e0b"}}>Warning: changes after that snapshot will be lost.</div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setResetOpen(false)} style={{padding:"6px 14px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Cancel</button>
              <button onClick={()=>setResetConfirm(true)} style={{padding:"6px 14px",background:"#b45309",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>Continue</button>
            </div>
          </Overlay>)}
        {resetOpen&&resetConfirm&&(()=>{const ok=resetText==="reset";return(
          <Overlay>
            <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9",marginBottom:10}}>Confirm rollback to {resetWindow}</div>
            <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>Type <strong style={{color:"#ef4444"}}>reset</strong> to confirm.</div>
            <input value={resetText} onChange={e=>setResetText(e.target.value)} placeholder="reset" style={{width:"100%",background:"#0f172a",color:"#f1f5f9",border:ok?"1px solid #22c55e":"1px solid #334155",borderRadius:6,padding:"8px",fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:18}}/>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>{setResetConfirm(false);setResetText("");}} style={{padding:"6px 14px",background:"transparent",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:13}}>Back</button>
              <button onClick={doReset} disabled={!ok} style={{padding:"6px 14px",background:ok?"#dc2626":"#334155",color:ok?"#fff":"#64748b",border:"none",borderRadius:6,cursor:ok?"pointer":"not-allowed",fontSize:13,fontWeight:600}}>Restore</button>
            </div>
          </Overlay>);})()}

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <div>
            <h1 style={{margin:0,fontSize:19,fontWeight:700,color:"#f1f5f9"}}>{CFG.emoji} {CFG.projectName}</h1>
            <p style={{margin:0,fontSize:11,color:"#64748b"}}>
              <span style={{color:"#a78bfa",fontWeight:600}}>Sprint {activeSprint} active</span>{" · "}
              {fmtDate(sprintStartDate(activeSprint))}–{fmtDate(sprintEndDate(activeSprint))}{" · "}
              <button onClick={()=>setShowAllSprints(o=>!o)} style={{background:"none",border:"none",color:showAllSprints?"#f59e0b":"#475569",cursor:"pointer",fontSize:11,padding:0,textDecoration:"underline"}}>{showAllSprints?"Show upcoming only":"Show all sprints"}</button>
              {rows&&rows.length===0&&<span style={{color:"#f59e0b",marginLeft:8}}>⚠ No data — import to begin</span>}
            </p>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:saveCfg.color,background:saveCfg.bg,padding:"3px 10px",borderRadius:20}}>{saveCfg.text}</span>
            <div style={{display:"flex",background:"#0f172a",borderRadius:6,padding:3,border:"1px solid #334155"}}>
              {[["backlog","📋 Backlog"],["epic","🗂️ Epics"],["timeline","📅 Timeline"],["roadmap","🚀 Roadmap"]].map(([v,l])=>(
                <button key={v} onClick={()=>setView(v)} style={{padding:"4px 12px",borderRadius:4,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:view===v?"#1e293b":"transparent",color:view===v?"#f1f5f9":"#64748b"}}>{l}</button>
              ))}
            </div>
            <ToolsMenu onImport={()=>setImportOpen(true)} onExport={()=>exportToCSV(rows||[])} onDups={()=>setDupsOpen(true)} onRollback={openReset} onSettings={()=>setSettingsOpen(true)} onRefreshOpen={isArtifactRuntime()?null:()=>refreshFromJira(true)} dupCount={dupCount}/>
            {!isArtifactRuntime()&&<button onClick={()=>refreshFromJira(false)} disabled={jiraBusy} title="Pull the latest from your Jira filter and sync" style={{padding:"6px 14px",background:jiraBusy?"#334155":"#0e7490",color:"#fff",border:"none",borderRadius:6,cursor:jiraBusy?"wait":"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>{jiraBusy?"⏳ Syncing…":"🔄 Refresh from Jira"}</button>}
            <button onClick={()=>setImportOpen(true)} style={{padding:"6px 14px",background:"#1d4ed8",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>📥 Import</button>
            <button onClick={addRow} style={{padding:"6px 14px",background:"#334155",color:"#94a3b8",border:"1px solid #334155",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>+ Add Ticket</button>
          </div>
        </div>

        {rows&&rows.length>0&&!sideViews&&(
          <SprintOverview rows={rows} teamCapacity={teamCapacity} onTeamCapChange={updateTeamCapacity} visibleSprints={visibleSprints} activeTeams={activeTeams}/>
        )}

        {selected.size>0&&!sideViews&&(
          <div style={{background:"#1e293b",border:"1px solid #3b82f6",borderRadius:8,padding:"8px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:"#93c5fd",fontWeight:700,whiteSpace:"nowrap"}}>{selected.size} selected</span>
            <div style={{width:1,height:20,background:"#334155"}}/>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:10,color:"#64748b"}}>Set priority:</span>
              <div style={{display:"flex",gap:4}}>{PRIORITY_OPTS.map(p=>{const col=PRIORITY_COL[p];return(<button key={p} onClick={()=>setRows(rs=>rs.map(r=>selected.has(r._id)?{...r,priority:p}:r))} style={{padding:"3px 8px",borderRadius:5,border:"1px solid "+col+"44",background:col+"18",color:col,fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>{p}</button>);})}</div>
            </div>
            <div style={{width:1,height:20,background:"#334155"}}/>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:10,color:"#64748b"}}>Set sprint:</span>
              <select defaultValue="" onChange={e=>{const v=e.target.value;if(!v)return;setRows(rs=>rs.map(r=>selected.has(r._id)?{...r,sprint:v}:r));e.target.value="";}} style={{background:"#0f172a",color:"#94a3b8",border:"1px solid #334155",borderRadius:5,padding:"3px 8px",fontSize:10,fontWeight:600,cursor:"pointer",outline:"none"}}><option value="">Sprint…</option>{sprintOpts.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            <div style={{width:1,height:20,background:"#334155"}}/>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:10,color:"#64748b"}}>Set theme:</span>
              <select defaultValue="" onChange={e=>{const v=e.target.value;if(!v)return;setRows(rs=>rs.map(r=>selected.has(r._id)?{...r,theme:v,_themeOverride:true}:r));e.target.value="";}} style={{background:"#0f172a",color:"#94a3b8",border:"1px solid #334155",borderRadius:5,padding:"3px 8px",fontSize:10,fontWeight:600,cursor:"pointer",outline:"none"}}><option value="">Theme…</option>{Object.keys(allThemes).map(t=><option key={t} value={t}>{t}</option>)}</select>
            </div>
            <div style={{width:1,height:20,background:"#334155"}}/>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:10,color:"#64748b"}}>Set team:</span>
              <select defaultValue="" onChange={e=>{const v=e.target.value;if(!v)return;setRows(rs=>rs.map(r=>selected.has(r._id)?{...r,team:v}:r));e.target.value="";}} style={{background:"#0f172a",color:"#94a3b8",border:"1px solid #334155",borderRadius:5,padding:"3px 8px",fontSize:10,fontWeight:600,cursor:"pointer",outline:"none"}}><option value="">Team…</option>{activeTeams.filter(t=>t!=="All").map(t=><option key={t} value={t}>{teamLabel(t)}</option>)}</select>
            </div>
            <div style={{width:1,height:20,background:"#334155"}}/>
            {selected.size>=2&&<button onClick={()=>{setMergeCandidates(null);setMergeOpen(true);}} style={{padding:"4px 12px",background:"#7c3aed",color:"#fff",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600}}>🔀 Merge</button>}
            <button onClick={()=>setSelected(new Set())} style={{marginLeft:"auto",padding:"4px 10px",background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:5,cursor:"pointer",fontSize:11}}>✕ Clear</button>
          </div>
        )}

        {rows&&rows.length>0&&!sideViews&&(
          <FilterBar filters={filters} setFilters={setFilters} allThemes={allThemes} activeTeams={activeTeams} sprintOpts={sprintOpts}
            count={view==="backlog"?sorted.length:filtered.length} pts={(view==="backlog"?sorted:filtered).reduce((a,r)=>a+(r.points||0),0)}/>
        )}

        {!rows||rows.length===0?(
          <EmptyState onImport={()=>setImportOpen(true)} onSetup={()=>setWizardOpen(true)}/>
        ):view==="timeline"?(
          <TimelineView rows={rows} allThemes={allThemes} onMarkAllCritical={markAllCritical} teamCapacity={teamCapacity}/>
        ):view==="roadmap"?(
          <RoadmapView rows={rows} allThemes={allThemes} aiCache={aiCache} ensureSummary={ensureSummary} onRegenAll={regenAll}/>
        ):view==="epic"?(
          <EpicView rows={rows} filters={filters} allThemes={allThemes}/>
        ):(
          <div style={{background:"#1e293b",borderRadius:10,overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr style={{background:"#0f172a"}}>
                <th style={{borderBottom:"1px solid #334155",width:30,padding:"0 6px"}}>{(()=>{const allSel=sorted.length>0&&sorted.every(r=>selected.has(r._id));const someSel=!allSel&&sorted.some(r=>selected.has(r._id));return(<div onClick={()=>{if(allSel)setSelected(new Set());else setSelected(new Set(sorted.map(r=>r._id)));}} style={{width:14,height:14,borderRadius:3,border:allSel||someSel?"1px solid #3b82f6":"1px solid #475569",background:allSel?"#3b82f6":"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",margin:"0 auto"}}>{allSel&&<span style={{color:"#fff",fontSize:9}}>✓</span>}{someSel&&<span style={{color:"#3b82f6",fontSize:9}}>—</span>}</div>);})()}</th>
                {COLS.map(c=>(<th key={c.key} style={{borderBottom:"1px solid #334155",padding:0}}><button onClick={()=>handleColSort(c.key)} style={thBtn(c.key)}>{c.label}{sortCol===c.key?<span style={{fontSize:8,marginLeft:2,color:"#60a5fa"}}>{sortDir==="asc"?"↑":"↓"}</span>:<span style={{opacity:0.2,fontSize:8,marginLeft:2}}>↕</span>}</button></th>))}
                <th style={{borderBottom:"1px solid #334155",width:70,padding:"0 6px"}}><span style={{fontSize:9,fontWeight:600,color:"#475569",textTransform:"uppercase",letterSpacing:0.5}}>📅 Due</span></th>
                <th style={{borderBottom:"1px solid #334155",padding:0}}><button onClick={()=>handleColSort("notes")} style={thBtn("notes")}>Notes{sortCol==="notes"?<span style={{fontSize:8,marginLeft:2,color:"#60a5fa"}}>{sortDir==="asc"?"↑":"↓"}</span>:<span style={{opacity:0.2,fontSize:8,marginLeft:2}}>↕</span>}</button></th>
                <th style={{borderBottom:"1px solid #334155",width:24}}/>
              </tr></thead>
              <tbody>{sorted.map((r,i)=>{
                const isSel=selected.has(r._id);const isDone=DONE_STATUSES.has(r.status);
                const rowBg=isSel?"rgba(29,78,216,0.12)":isDone?"rgba(15,23,42,0.6)":i%2===0?"#1e293b":"#192236";
                return(
                  <tr key={r._id} style={{borderBottom:"1px solid #0f172a",background:rowBg,opacity:isDone?0.5:1}}>
                    <td style={{padding:"5px 6px",textAlign:"center"}} onClick={()=>toggleSelect(r._id)}><div style={{width:14,height:14,borderRadius:3,border:isSel?"1px solid #3b82f6":"1px solid #334155",background:isSel?"#3b82f6":"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",margin:"0 auto"}}>{isSel&&<span style={{color:"#fff",fontSize:9}}>✓</span>}</div></td>
                    <td style={{padding:"5px 6px",width:60}}><PillSelect value={r.team||"?"} opts={activeTeams.filter(t=>t!=="All")} onChange={v=>update(r._id,"team",v)} getColor={teamColor} labelFn={teamLabel}/></td>
                    <td style={{padding:"5px 6px",width:85}}><EditCell value={r.id} onChange={v=>update(r._id,"id",v)} mono/></td>
                    <td style={{padding:"5px 6px",width:115}}><ThemeSelect value={r.theme||"Uncategorised"} opts={Object.keys(allThemes)} onChange={v=>update(r._id,"theme",v)} colorMap={allThemes} onNewTheme={(name,color)=>saveConfig({...config,themes:{...config.themes,[name]:color}})} onRemoveTheme={name=>{const n={...config.themes};delete n[name];saveConfig({...config,themes:n});}}/></td>
                    <td style={{padding:"5px 6px",fontWeight:600,color:"#f1f5f9",width:190}}><EditCell value={r.title} onChange={v=>update(r._id,"title",v)}/></td>
                    <td style={{padding:"5px 6px",width:105}}>
                      <div style={{display:"flex",alignItems:"center",gap:3}}>
                        {CFG.protectPriority&&!(CFG.priorityMapTeams||[]).includes(r.team)&&<Tip text="Priority protected — not overwritten on import. Unlock per-team in Settings."><span style={{fontSize:9}}>🔒</span></Tip>}
                        <PillSelect value={r.priority||defaultPriority()} opts={PRIORITY_OPTS} onChange={v=>update(r._id,"priority",v)} getColor={p=>PRIORITY_COL[p]}/>
                      </div>
                    </td>
                    <td style={{padding:"5px 6px",width:95}}><PillSelect value={r.sprint||"TBD"} opts={sprintOpts} onChange={v=>update(r._id,"sprint",v)} getColor={s=>{const n=sprintNumOf(s);return n>0?sprintCol(n):"#64748b";}}/></td>
                    <td style={{padding:"5px 6px",width:50,textAlign:"center"}}><input type="number" min={0} max={999} value={r.points!=null?r.points:""} onChange={e=>update(r._id,"points",e.target.value)} placeholder="—" style={{width:36,background:"#0f172a",border:"1px solid #334155",borderRadius:5,color:r.points!=null?"#f59e0b":"#475569",fontWeight:700,fontSize:12,padding:"3px",textAlign:"center",outline:"none"}}/></td>
                    <td style={{padding:"5px 5px",width:130}}><StatusDot value={r.status||"To Do"} onChange={v=>update(r._id,"status",v)}/></td>
                    <td style={{padding:"5px 10px",width:90,whiteSpace:"nowrap"}}>{r.sprint&&r.sprint!=="TBD"?(()=>{const sn=sprintNumOf(r.sprint);const ed=sprintEndDate(sn);const col=sprintCol(sn);return(<Tip text={"Sprint ends "+fmtDate(ed)}><span style={{fontSize:11,color:col,display:"flex",alignItems:"center",gap:4,cursor:"default"}}><span style={{fontSize:13}}>📅</span><span style={{fontWeight:700}}>{fmtDate(ed)}</span></span></Tip>);})():(<span style={{fontSize:11,color:"#334155"}}>—</span>)}</td>
                    <td style={{padding:"5px 6px",color:"#64748b",width:155}}><EditCell value={r.notes||""} onChange={v=>update(r._id,"notes",v)}/></td>
                    <td style={{padding:"5px 6px",textAlign:"center",width:24}}><button onClick={()=>setDeleteTarget(r._id)} style={{background:"none",border:"none",cursor:"pointer",color:"#334155",fontSize:12}} onMouseEnter={e=>e.currentTarget.style.color="#ef4444"} onMouseLeave={e=>{e.currentTarget.style.color="#334155";}}>✕</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
            {sorted.length===0&&<div style={{textAlign:"center",padding:"40px",color:"#475569",fontSize:13}}>No tickets match the current filters</div>}
          </div>
        )}

        <div style={{marginTop:8,fontSize:10,color:"#334155",textAlign:"center"}}>
          Import is source of truth · Priority protected ({CFG.keyPrefix||"—"} primary) · Descriptions & edits preserved · AI summaries cached · Click capacity to edit · Select 2+ to merge · ⚙️ Settings to white-label
        </div>
      </div>
    </div>
  );
}

