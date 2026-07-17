import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig, cfgTimeout } from "../config";
import { curlFetch } from "../curl-fetch";
import { tmux } from "../tmux";

type HealthCheck = { name: string; status: string; detail: string };

const FALLBACK_HTML_MARKERS = [
  "maw-ui not installed",
  "maw-ui is not installed",
  "maw-ui is not installed or has not been built yet",
  "<title>maw</title>",
];

function checkUiDist(checks: HealthCheck[]) {
  const distDir = process.env.MAW_UI_DIR || join(homedir(), ".maw", "ui", "dist");
  const indexHtml = join(distDir, "index.html");
  if (existsSync(indexHtml)) {
    checks.push({ name: "maw ui dist", status: "ok", detail: `index.html found (${distDir})` });
  } else {
    checks.push({ name: "maw ui dist", status: "fail", detail: `missing ${indexHtml}; alert helm` });
  }
  return { distDir, indexHtml };
}

async function checkUiRoot(checks: HealthCheck[], port: number) {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(cfgTimeout("health")),
    });
    const html = await res.text();
    if (!res.ok) {
      checks.push({ name: "maw ui root", status: "warn", detail: `HTTP ${res.status}; alert helm` });
      return;
    }
    const isFallback = FALLBACK_HTML_MARKERS.some(marker => html.includes(marker));
    checks.push({
      name: "maw ui root",
      status: isFallback ? "fail" : "ok",
      detail: isFallback ? "serving fallback HTML; alert helm" : "serving built UI",
    });
  } catch {
    checks.push({ name: "maw ui root", status: "warn", detail: `unreachable on :${port}; alert helm if live root fails` });
  }
}

export async function cmdHealth() {
  const checks: HealthCheck[] = [];

  // 1. tmux
  try {
    const sessions = await tmux.listSessions();
    checks.push({ name: "tmux server", status: "ok", detail: `running (${sessions.length} sessions)` });
  } catch {
    checks.push({ name: "tmux server", status: "fail", detail: "not running" });
  }

  // 2. maw server
  try {
    const port = loadConfig().port;
    const res = await fetch(`http://localhost:${port}/api/sessions`, { signal: AbortSignal.timeout(cfgTimeout("health")) });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data) ? data.length : (data.sessions?.length || 0);
      checks.push({ name: "maw server", status: "ok", detail: `online (:${port}, ${count} sessions)` });
    } else {
      checks.push({ name: "maw server", status: "warn", detail: `HTTP ${res.status}` });
    }
  } catch {
    checks.push({ name: "maw server", status: "fail", detail: "offline" });
  }

  // 3. packed maw-ui dist + root fallback guard
  const uiConfig = loadConfig();
  checkUiDist(checks);
  await checkUiRoot(checks, uiConfig.port);

  // 4. disk
  try {
    const df = execSync("df -h /tmp | tail -1", { encoding: "utf-8" }).trim();
    const parts = df.split(/\s+/);
    const avail = parts[3] || "?";
    const pct = parseInt(parts[4] || "0");
    checks.push({ name: "disk /tmp", status: pct > 90 ? "warn" : "ok", detail: `${avail} free` });
  } catch {
    checks.push({ name: "disk /tmp", status: "warn", detail: "unknown" });
  }

  // 5. memory
  try {
    const mem = execSync("free -m | grep Mem", { encoding: "utf-8" }).trim();
    const parts = mem.split(/\s+/);
    const avail = parseInt(parts[6] || "0");
    checks.push({ name: "memory", status: avail < 500 ? "warn" : "ok", detail: `${avail}MB available` });
  } catch {
    checks.push({ name: "memory", status: "warn", detail: "unknown" });
  }

  // 6. pm2
  try {
    const pm2 = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8" });
    const procs = JSON.parse(pm2);
    const maw = procs.find((p: any) => p.name === "maw");
    if (maw) {
      checks.push({ name: "pm2 maw", status: maw.pm2_env?.status === "online" ? "ok" : "warn", detail: `${maw.pm2_env?.status} (pid ${maw.pid})` });
    } else {
      checks.push({ name: "pm2 maw", status: "fail", detail: "not found" });
    }
  } catch {
    checks.push({ name: "pm2 maw", status: "warn", detail: "pm2 not available" });
  }

  // 7. peers
  const config = loadConfig();
  const peers = (config as any).peers || [];
  if (peers.length === 0) {
    checks.push({ name: "peers", status: "none", detail: "none configured" });
  } else {
    for (const peer of peers) {
      try {
        const r = await curlFetch(`${peer}/api/federation/status`, { timeout: cfgTimeout("health") });
        checks.push({ name: `peer ${peer}`, status: r.ok ? "ok" : "warn", detail: r.ok ? "online" : `HTTP ${r.status}` });
      } catch {
        checks.push({ name: `peer ${peer}`, status: "fail", detail: "unreachable" });
      }
    }
  }

  // Output
  console.log("\nmaw health\n");
  for (const c of checks) {
    const icon = c.status === "ok" ? "\x1b[32m●\x1b[0m" : c.status === "warn" ? "\x1b[33m●\x1b[0m" : c.status === "fail" ? "\x1b[31m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    console.log(`  ${icon} ${c.name.padEnd(18)} ${c.detail}`);
  }
  console.log();
}
