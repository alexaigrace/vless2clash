import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Usage: QA_BASE_URL=https://your-worker.workers.dev node scripts/qa-cloudflare.mjs
// Retry interrupted cleanup: node scripts/qa-cloudflare.mjs --cleanup-only
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDir = path.join(root, "artifacts", "qa-cloudflare");
const recoveryDir = path.join(root, ".cache", "qa-cloudflare");
const recoveryFile = path.join(recoveryDir, "cleanup.json");
const reportFile = path.join(outputDir, "report.json");
const baseInput = process.env.QA_BASE_URL || process.argv.find((arg) => arg.startsWith("https://"));
const cleanupOnly = process.argv.includes("--cleanup-only");
const timeoutMs = 10_000;
const propagationMs = 90_000;
const report = {
  checkedAt: new Date().toISOString(),
  environment: "Cloudflare HTTPS",
  checks: [],
  cleanup: "not-needed",
  status: "incomplete",
};
let record = null;
let browser = null;
let activeCheck = "";

function addCheck(name, status) {
  report.checks.push({ name, status });
  console.log(`${status.toUpperCase()} ${name}`);
}

async function saveReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function saveRecovery(value) {
  await mkdir(recoveryDir, { recursive: true });
  await writeFile(recoveryFile, JSON.stringify(value), { mode: 0o600 });
  await chmod(recoveryFile, 0o600);
}

async function loadRecovery() {
  try {
    return JSON.parse(await readFile(recoveryFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validatedBase(raw) {
  assert.ok(raw, "Set QA_BASE_URL to the deployed HTTPS origin.");
  const url = new URL(raw);
  assert.equal(url.protocol, "https:", "QA requires an HTTPS origin.");
  assert.equal(url.pathname, "/", "QA_BASE_URL must be the site origin.");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  return url.origin;
}

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "cache-control": "no-cache",
      ...(options.headers || {}),
    },
  });
}

async function api(origin, route, options = {}) {
  return request(new URL(route, origin), {
    ...options,
    headers: { origin, ...(options.headers || {}) },
  });
}

async function check(name, callback) {
  activeCheck = name;
  await callback();
  addCheck(name, "pass");
}

async function waitFor(name, callback) {
  activeCheck = name;
  const deadline = Date.now() + propagationMs;
  while (Date.now() < deadline) {
    if (await callback()) {
      addCheck(name, "pass");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${name}: propagation timed out`);
}

async function findBrowser(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBrowser(candidate);
      if (nested) return nested;
    } else if (["chrome-headless-shell", "chromium", "chrome"].includes(entry.name)
      && (await stat(candidate)).mode & 0o111) {
      return candidate;
    }
  }
  return null;
}

function fixture(version) {
  return [
    "proxies:",
    "  - name: QA-Reserved",
    "    type: vless",
    "    server: 192.0.2.1",
    "    port: 443",
    "    uuid: 00000000-0000-4000-8000-000000000001",
    "    tls: true",
    "proxy-groups:",
    "  - name: QA-Group",
    "    type: select",
    "    proxies:",
    "      - QA-Reserved",
    "rules:",
    "  - MATCH,QA-Group",
    `# qa-version: ${version}`,
    "",
  ].join("\n");
}

async function cleanup(saved) {
  if (!saved) return;
  const origin = validatedBase(saved.origin);
  const route = `/api/subscriptions/${encodeURIComponent(saved.id)}`;
  const headers = { authorization: `Bearer ${saved.manageToken}` };
  const deadline = Date.now() + propagationMs;
  while (Date.now() < deadline) {
    try {
      const response = await api(origin, route, { method: "DELETE", headers });
      if (response.status === 204 || response.status === 404) {
        const read = await api(origin, `/sub/${encodeURIComponent(saved.id)}.yaml`);
        if (read.status === 404) {
          report.cleanup = "confirmed-404";
          await rm(recoveryFile);
          return;
        }
      }
    } catch {
      // Keep the ignored recovery file and retry transient network failures.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Temporary subscription cleanup could not be confirmed.");
}

try {
  const previous = await loadRecovery();
  if (previous) {
    await cleanup(previous);
    addCheck("previous temporary record cleanup", "pass");
  }
  if (!cleanupOnly) {
    const origin = validatedBase(baseInput);
    report.origin = origin;

    await check("HTTPS page and built assets", async () => {
      const page = await request(origin);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") || "", /text\/html/u);
      const html = await page.text();
      assert.match(html, /折流/u);
      const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/gu)]
        .map((match) => match[1]);
      assert.ok(files.some((file) => file.endsWith(".js")));
      assert.ok(files.some((file) => file.endsWith(".css")));
      for (const file of files) {
        const asset = await request(new URL(file, origin));
        assert.equal(asset.status, 200);
        assert.ok((await asset.arrayBuffer()).byteLength > 0);
      }
    });

    const yamlOne = fixture("one");
    const yamlTwo = fixture("two");
    const createBody = JSON.stringify({ name: "QA reserved example", yaml: yamlOne });
    await check("cross-origin create rejected", async () => {
      const response = await api(origin, "/api/subscriptions", {
        method: "POST",
        headers: { origin: "https://cross-origin.invalid", "content-type": "application/json" },
        body: createBody,
      });
      assert.equal(response.status, 403);
    });

    await check("create temporary subscription", async () => {
      const response = await api(origin, "/api/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      });
      assert.equal(response.status, 201);
      const created = await response.json();
      assert.match(created.id, /^[A-Za-z0-9_-]{32,64}$/u);
      assert.match(created.manageToken, /^[A-Za-z0-9_-]{40,64}$/u);
      assert.equal(new URL(created.url).origin, origin);
      assert.equal(new URL(created.url).pathname, `/sub/${created.id}.yaml`);
      record = { origin, id: created.id, manageToken: created.manageToken };
      await saveRecovery(record);
    });

    const readRoute = `/sub/${encodeURIComponent(record.id)}.yaml`;
    const manageRoute = `/api/subscriptions/${encodeURIComponent(record.id)}`;
    await waitFor("read published YAML", async () => {
      const response = await api(origin, readRoute);
      if (response.status === 404 || response.status === 503) return false;
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") || "", /yaml/u);
      assert.match(response.headers.get("cache-control") || "", /no-store/u);
      const disposition = response.headers.get("content-disposition") || "";
      const body = await response.text();
      return /filename\*=UTF-8''QA%20reserved%20example(?:;|$)/u.test(disposition)
        && body === yamlOne;
    });

    await check("wrong management token rejected", async () => {
      const response = await api(origin, manageRoute, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${"A".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "QA invalid token", yaml: yamlTwo }),
      });
      assert.equal(response.status, 401);
    });

    await check("wrong token cannot delete", async () => {
      const response = await api(origin, manageRoute, {
        method: "DELETE",
        headers: { authorization: `Bearer ${"A".repeat(43)}` },
      });
      assert.equal(response.status, 401);
    });

    await check("cross-origin management rejected", async () => {
      const response = await api(origin, manageRoute, {
        method: "DELETE",
        headers: {
          origin: "https://cross-origin.invalid",
          authorization: `Bearer ${record.manageToken}`,
        },
      });
      assert.equal(response.status, 403);
    });

    await check("restore in real browser", async () => {
      const executablePath = process.env.QA_CHROMIUM_EXECUTABLE
        || await findBrowser(path.join(root, ".cache", "playwright"))
        || chromium.executablePath();
      browser = await chromium.launch({ headless: true, executablePath });
      const page = await browser.newPage();
      page.setDefaultTimeout(timeoutMs);
      const response = await page.goto(origin, { waitUntil: "networkidle", timeout: timeoutMs });
      assert.equal(response.status(), 200);
      assert.match(await page.locator("#publish-data-notice").innerText(), /Cloudflare KV/u);
      await page.locator(".restore-panel > summary").click();
      await page.locator("#restore-id").fill(record.id);
      await page.locator("#restore-token").fill(record.manageToken);
      const deadline = Date.now() + propagationMs;
      while (Date.now() < deadline && !await page.locator("#subscription-result").isVisible()) {
        await page.locator("#restore-button").click();
        try {
          await page.locator("#subscription-result").waitFor({ state: "visible", timeout: 2_000 });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      assert.equal(await page.locator("#subscription-result").isVisible(), true);
      assert.equal(new URL(await page.locator("#subscription-url").inputValue()).origin, origin);
      assert.match(await page.locator("#subscription-scope").innerText(), /Cloudflare KV.*凭据/u);
    });

    await check("update with management token", async () => {
      const response = await api(origin, manageRoute, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${record.manageToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "QA reserved updated", yaml: yamlTwo }),
      });
      assert.equal(response.status, 200);
    });

    await waitFor("read updated YAML", async () => {
      const response = await api(origin, readRoute);
      if (response.status === 404 || response.status === 503) return false;
      assert.equal(response.status, 200);
      const disposition = response.headers.get("content-disposition") || "";
      const body = await response.text();
      return /filename\*=UTF-8''QA%20reserved%20updated(?:;|$)/u.test(disposition)
        && body === yamlTwo;
    });
  }
} catch (error) {
  report.status = "failed";
  // Never persist request bodies, subscription IDs, management tokens or response text.
  report.failure = { step: activeCheck || "setup", kind: error instanceof Error ? error.name : "UnknownError" };
  console.error(`FAIL ${report.failure.step} (${report.failure.kind})`);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      report.status = "failed";
      console.error("FAIL closing browser");
    }
  }
  const saved = record || await loadRecovery();
  if (saved) {
    try {
      await cleanup(saved);
      addCheck("temporary record deleted", "pass");
    } catch {
      report.cleanup = "needs-retry";
      report.status = "failed";
      console.error("FAIL temporary record cleanup; run --cleanup-only to retry.");
    }
  }
  if (report.status !== "failed") report.status = "passed";
  await saveReport();
  console.log(`QA status: ${report.status}; sanitized report: artifacts/qa-cloudflare/report.json`);
}

if (report.status !== "passed") process.exitCode = 1;
