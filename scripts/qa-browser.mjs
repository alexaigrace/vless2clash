import assert from "node:assert/strict";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseURL = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const outputDir = path.join(root, "artifacts", "qa");
const browserCache = path.join(root, ".cache", "playwright");

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
    } else if (
      ["chrome-headless-shell", "chromium", "chrome"].includes(entry.name) &&
      (await stat(candidate)).mode & 0o111
    ) {
      return candidate;
    }
  }
  return null;
}

const executablePath =
  process.env.QA_CHROMIUM_EXECUTABLE ||
  (await findBrowser(browserCache)) ||
  chromium.executablePath();
const browser = await chromium.launch({ headless: true, executablePath });
const downloadsDir = path.join(outputDir, "downloads");
await mkdir(downloadsDir, { recursive: true });
const failures = [];
const results = [];

async function check(name, callback) {
  try {
    await callback();
    results.push(`PASS ${name}`);
  } catch (error) {
    failures.push(`FAIL ${name}: ${error.message}`);
  }
}

async function expectDownload(page, button, expectedFilename) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator(button).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), expectedFilename);
  const filePath = path.join(downloadsDir, expectedFilename);
  await download.saveAs(filePath);
  return filePath;
}

async function freshPage(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  return { context, page, requests, dialogs };
}

async function prepareSamplePreview(page) {
  await page.locator("#sample-button").click();
  await page.locator("#generate-button").click();
  await page.waitForFunction(
    () => document.querySelector("#preview-state")?.dataset.state === "ready",
  );
}

async function deleteWithCredentials(page, id, token) {
  if (!id || !token) return;
  await page.request.delete(new URL(`/api/subscriptions/${id}`, baseURL).href, {
    headers: {
      origin: new URL(baseURL).origin,
      authorization: `Bearer ${token}`,
    },
  });
}

async function staleCacheProbe() {
  const { context, page, requests } = await freshPage({ width: 1280, height: 900 });
  let id;
  let token;
  let staleResponseSent = false;
  await page.route("**/sub/*.yaml", async (route) => {
    if (!staleResponseSent) {
      staleResponseSent = true;
      await route.fulfill({
        status: 200,
        contentType: "application/yaml; charset=utf-8",
        body: "proxies: []\nproxy-groups: []\n",
      });
      return;
    }
    await route.continue();
  });

  try {
    await prepareSamplePreview(page);
    await page.locator("#publish-button").click();
    await page.locator("#subscription-result").waitFor({ state: "visible" });
    id = new URL(await page.locator("#subscription-url").inputValue())
      .pathname.match(/^\/sub\/([^/]+)\.yaml$/u)?.[1];
    token = await page.locator("#manage-token").inputValue();
    await page.locator("#hosting-notice").waitFor({ state: "visible" });
    assert.equal(staleResponseSent, true);
    assert.match(await page.locator("#hosting-notice-text").innerText(), /不同/u);
    assert.notEqual(
      await page.locator("#subscription-confirmation").getAttribute("data-confirmed"),
      "true",
    );

    await page.locator("#retry-read-button").click();
    await page.waitForFunction(
      () => document.querySelector("#subscription-confirmation")?.dataset.confirmed === "true",
    );
    assert.equal(await page.locator("#hosting-notice").isVisible(), false);
    assert.equal(
      requests.filter((url) => new URL(url).pathname === "/api/subscriptions").length,
      1,
      "retrying a stale read should not publish a second subscription",
    );
    assert.match(
      await page.locator("#subscription-confirmation").innerText(),
      /提交内容已确认/u,
    );
  } finally {
    await deleteWithCredentials(page, id, token);
    await context.close();
  }
}

async function managementBusyProbe() {
  const { context, page } = await freshPage({ width: 1280, height: 900 });
  let id;
  let token;
  let releaseUpdate;
  let enteredUpdate;
  let enteredUpdateResolve;
  let updateCount = 0;
  const updateGate = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  enteredUpdate = new Promise((resolve) => {
    enteredUpdateResolve = resolve;
  });

  try {
    await prepareSamplePreview(page);
    await page.locator("#publish-button").click();
    await page.locator("#subscription-result").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.querySelector("#subscription-confirmation")?.dataset.confirmed === "true",
    );
    id = new URL(await page.locator("#subscription-url").inputValue())
      .pathname.match(/^\/sub\/([^/]+)\.yaml$/u)?.[1];
    token = await page.locator("#manage-token").inputValue();

    await page.locator("#subscription-name").fill("QA busy state update");
    await page.locator("#generate-button").click();
    await page.route(new URL(`/api/subscriptions/${id}`, baseURL).href, async (route) => {
      if (route.request().method() === "PUT") {
        updateCount += 1;
        enteredUpdateResolve();
        await updateGate;
      }
      await route.continue();
    });

    await page.locator("#update-button").click();
    await Promise.race([
      enteredUpdate,
      new Promise((_, reject) => setTimeout(() => reject(new Error("update request did not start")), 5000)),
    ]);
    assert.equal(await page.locator("#update-button").isDisabled(), true);
    assert.equal(await page.locator("#update-button").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#publish-button").isDisabled(), true);
    assert.equal(await page.locator("#restore-button").isDisabled(), true);
    assert.equal(await page.locator("#restore-id").isDisabled(), true);
    assert.equal(await page.locator("#restore-token").isDisabled(), true);
    assert.equal(await page.locator("#show-delete-button").isDisabled(), true);
    await page.locator("#update-button").click({ force: true });
    await page.waitForTimeout(100);
    assert.equal(updateCount, 1, "busy update control should not send a duplicate request");
    releaseUpdate();

    await page.waitForFunction(() => {
      const confirmation = document.querySelector("#subscription-confirmation");
      const update = document.querySelector("#update-button");
      return confirmation?.textContent === "更新内容可读取" &&
        confirmation.dataset.confirmed === "true" &&
        update?.getAttribute("aria-busy") === "false";
    });
    assert.equal(updateCount, 1, "one management operation should produce one PUT request");
    assert.equal(await page.locator("#update-button").isDisabled(), false);
    assert.equal(await page.locator("#restore-button").isDisabled(), false);
  } finally {
    releaseUpdate?.();
    await deleteWithCredentials(page, id, token);
    await context.close();
  }
}

try {
  await mkdir(outputDir, { recursive: true });

  for (const [label, viewport, filename] of [
    ["desktop", { width: 1280, height: 900 }, "desktop.png"],
    ["mobile", { width: 375, height: 812 }, "mobile.png"],
  ]) {
    const { context, page } = await freshPage(viewport);
    await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
    await check(`${label} viewport renders the initial empty state`, async () => {
      assert.equal(await page.locator("#empty-state").isVisible(), true);
    });
    await context.close();
  }

  const { context, page, requests, dialogs } = await freshPage({
    width: 1280,
    height: 900,
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await check("initial preview is empty and actions are disabled", async () => {
    assert.equal(await page.locator("#preview-state").textContent(), "尚未生成");
    assert.equal(await page.locator("#publish-button").isDisabled(), true);
    assert.equal(await page.locator("#copy-yaml-button").isDisabled(), true);
    assert.equal(await page.locator("#download-yaml-button").isDisabled(), true);
  });

  await page.locator("#sample-button").click();
  const input = page.locator("#links-input");
  const sample = await input.inputValue();
  assert.equal(sample.split("\n").length, 4, "the built-in sample should cover four protocols");
  const maliciousName = "<img src=x onerror=alert(1)>";
  const safeSample = sample.replace(/#示例-VLESS$/mu, `#${encodeURIComponent(maliciousName)}`);
  await input.fill(`${safeSample}\nnot-a-node`);
  await page.locator("#generate-button").click();

  await check("four sample protocols parse while the invalid row is reported", async () => {
    await page.locator("#nodes-list .node-row").first().waitFor();
    assert.equal(await page.locator("#node-count").textContent(), "4");
    assert.match(await page.locator("#parse-errors").innerText(), /第 5 行/u);
    assert.equal(await page.locator("#nodes-list .node-row").count(), 4);
  });
  await check("node name is rendered as text without creating an image element", async () => {
    assert.equal(await page.locator("#nodes-list img").count(), 0);
    assert.ok((await page.locator("#nodes-list").innerText()).includes(maliciousName));
  });

  await page.locator("#yaml-tab").click();
  await check("YAML tab displays a generated configuration", async () => {
    assert.equal(await page.locator("#yaml-view").isVisible(), true);
    assert.match(await page.locator("#yaml-content").innerText(), /proxies:/u);
    assert.match(await page.locator("#yaml-content").innerText(), /RULE-SET,ads,REJECT/u);
  });
  await page.locator("#nodes-tab").click();
  await check("nodes tab returns to the node list", async () => {
    assert.equal(await page.locator("#nodes-view").isVisible(), true);
    assert.equal(await page.locator("#nodes-tab").getAttribute("aria-selected"), "true");
  });

  const prePublishRequests = [...requests];
  await check("conversion makes no API, subscription, or off-origin request", () => {
    assert.deepEqual(
      prePublishRequests.filter((url) => {
        const parsed = new URL(url);
        return parsed.origin !== new URL(baseURL).origin ||
          parsed.pathname.startsWith("/api/") ||
          parsed.pathname.startsWith("/sub/");
      }),
      [],
    );
  });

  await page.locator("#copy-yaml-button").click();
  await check("copy action writes generated YAML to the clipboard", async () => {
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /proxies:/u);
    assert.match(await page.locator("#action-status").innerText(), /已复制/u);
  });

  const yamlDownload = await expectDownload(
    page,
    "#download-yaml-button",
    "clash-config.yaml",
  );
  await check("YAML download contains the generated configuration", async () => {
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(yamlDownload, "utf8"), /proxies:/u);
  });

  await page.locator("#block-ads").uncheck();
  await page.locator("#direct-china").uncheck();
  await check("route summary follows both routing switches", async () => {
    assert.equal(await page.locator("#route-china-action").innerText(), "代理");
    assert.equal(await page.locator("#route-ads-action").innerText(), "关闭");
    assert.equal(await page.locator("#route-ads-target").innerText(), "广告拦截");
  });
  await check("changing a routing option invalidates the current preview", async () => {
    assert.equal(await page.locator("#preview-state").innerText(), "尚未生成");
    assert.equal(await page.locator("#publish-button").isDisabled(), true);
    assert.equal(await page.locator("#download-yaml-button").isDisabled(), true);
  });
  await page.locator("#block-ads").check();
  await page.locator("#direct-china").check();
  await page.locator("#generate-button").click();
  await page.locator("#publish-button").click();
  await page.locator("#subscription-result").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelector("#subscription-confirmation")?.dataset.confirmed === "true",
  );

  const subscriptionURL = await page.locator("#subscription-url").inputValue();
  const id = new URL(subscriptionURL).pathname.match(/^\/sub\/([^/]+)\.yaml$/u)?.[1];
  const token = await page.locator("#manage-token").inputValue();
  assert.ok(id);
  assert.ok(token);
  const getResponse = await page.request.get(subscriptionURL);
  await check("published URL returns YAML via GET", async () => {
    assert.equal(getResponse.status(), 200);
    assert.match(await getResponse.text(), /proxy-groups:/u);
  });

  const unauthorizedUpdate = await page.request.put(
    new URL(`/api/subscriptions/${id}`, baseURL).href,
    {
      data: { name: "Unauthorized", yaml: "proxies: []\n" },
      headers: {
        origin: new URL(baseURL).origin,
        "content-type": "application/json",
      },
    },
  );
  await check("unauthorized update cannot change the published YAML", async () => {
    assert.equal(unauthorizedUpdate.status(), 401);
    assert.match(await (await page.request.get(subscriptionURL)).text(), /proxies:/u);
  });

  const credentialFile = await expectDownload(
    page,
    "#download-credentials-button",
    "zheliu-subscription-credentials.txt",
  );
  await check("management credential file contains the test subscription credentials", async () => {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(credentialFile, "utf8");
    assert.ok(content.includes(id));
    assert.ok(content.includes(token));
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".restore-panel summary").click();
  await page.locator("#restore-id").fill(id);
  await page.locator("#restore-token").fill(token);
  await page.locator("#restore-button").click();
  await page.locator("#subscription-result").waitFor({ state: "visible" });
  await check("saved credentials restore management access", async () => {
    assert.equal(await page.locator("#subscription-url").inputValue(), subscriptionURL);
  });

  await page.locator("#subscription-name").fill("QA updated subscription");
  await page.locator("#sample-button").click();
  await page.locator("#generate-button").click();
  await page.waitForFunction(
    () => document.querySelector("#preview-state")?.dataset.state === "ready",
  );
  assert.equal(await page.locator("#update-button").isDisabled(), false);
  await page.locator("#update-button").click();
  await page.waitForFunction(() => {
    const confirmation = document.querySelector("#subscription-confirmation");
    const update = document.querySelector("#update-button");
    return confirmation?.textContent === "更新内容可读取" &&
      confirmation.dataset.confirmed === "true" &&
      update?.getAttribute("aria-busy") === "false";
  });
  const updatedYaml = await (await page.request.get(subscriptionURL)).text();
  await check("restored management updates YAML at the same URL", () => {
    assert.match(updatedYaml, /QA updated subscription/u);
  });

  await page.locator("#show-delete-button").click();
  await page.locator("#delete-confirmation-input").fill("删除");
  await check("delete confirmation stays disabled until the exact phrase is entered", async () => {
    assert.equal(await page.locator("#confirm-delete-button").isDisabled(), true);
  });
  await page.locator("#delete-confirmation-input").fill("删除订阅");
  await check("the exact delete phrase enables the delete action", async () => {
    assert.equal(await page.locator("#confirm-delete-button").isDisabled(), false);
  });
  await page.locator("#confirm-delete-button").click();
  await page.waitForFunction(
    () => !document.querySelector("#subscription-result") ||
      document.querySelector("#subscription-result").hidden,
  );
  const afterDelete = await page.request.get(subscriptionURL);
  await check("management delete removes the subscription URL", () => {
    assert.equal(afterDelete.status(), 404);
  });
  await check("delete flow uses typed confirmation without a second dialog", () => {
    assert.equal(dialogs.length, 0);
  });

  const clientRequests = requests.filter((url) => new URL(url).origin !== new URL(baseURL).origin);
  await check("page makes no off-origin request during tested local flows", () => {
    assert.deepEqual(clientRequests, []);
  });
  await context.close();

  await check("stale cached YAML is rejected until retry confirms the submitted content", staleCacheProbe);
  await check("management controls stay busy and block duplicate update requests", managementBusyProbe);
} catch (error) {
  failures.push(`FAIL browser flow: ${error.stack || error.message}`);
} finally {
  await browser.close();
}

console.log(`QA base URL: ${baseURL}`);
console.log(`Chromium: ${executablePath}`);
for (const result of results) console.log(result);
for (const failure of failures) console.error(failure);
console.log(`Screenshots: ${path.join(outputDir, "desktop.png")}, ${path.join(outputDir, "mobile.png")}`);
if (failures.length) process.exitCode = 1;
