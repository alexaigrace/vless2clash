import { parseLinks, buildConfig, SAMPLE_LINKS } from "./lib/engine.js";

const byId = (id) => document.getElementById(id);

const ui = {
  links: byId("links-input"),
  name: byId("subscription-name"),
  directChina: byId("direct-china"),
  blockAds: byId("block-ads"),
  routeChinaAction: byId("route-china-action"),
  routeAdsAction: byId("route-ads-action"),
  routeAdsTarget: byId("route-ads-target"),
  generate: byId("generate-button"),
  sample: byId("sample-button"),
  clear: byId("clear-button"),
  summary: byId("result-summary"),
  previewState: byId("preview-state"),
  errors: byId("parse-errors"),
  count: byId("node-count"),
  empty: byId("empty-state"),
  nodes: byId("nodes-list"),
  yaml: byId("yaml-content"),
  nodesView: byId("nodes-view"),
  yamlView: byId("yaml-view"),
  nodesTab: byId("nodes-tab"),
  yamlTab: byId("yaml-tab"),
  copyYaml: byId("copy-yaml-button"),
  downloadYaml: byId("download-yaml-button"),
  publish: byId("publish-button"),
  publishDataNotice: byId("publish-data-notice"),
  actionStatus: byId("action-status"),
  hostingNotice: byId("hosting-notice"),
  hostingNoticeText: byId("hosting-notice-text"),
  retryRead: byId("retry-read-button"),
  subscriptionResult: byId("subscription-result"),
  subscriptionUrl: byId("subscription-url"),
  subscriptionScope: byId("subscription-scope"),
  confirmation: byId("subscription-confirmation"),
  copyUrl: byId("copy-url-button"),
  manageToken: byId("manage-token"),
  revealToken: byId("reveal-token-button"),
  downloadCredentials: byId("download-credentials-button"),
  update: byId("update-button"),
  deleteToggle: byId("show-delete-button"),
  deletePanel: byId("delete-confirmation"),
  deleteInput: byId("delete-confirmation-input"),
  deleteConfirm: byId("confirm-delete-button"),
  restoreId: byId("restore-id"),
  restoreToken: byId("restore-token"),
  restoreButton: byId("restore-button"),
  restoreStatus: byId("restore-status"),
  subscriptionTitle: byId("subscription-title"),
};

let preview = null;
let subscription = null;
let managementBusy = false;

function setStatus(message, kind = "") {
  ui.actionStatus.textContent = message;
  ui.actionStatus.dataset.kind = kind;
}

function setRestoreStatus(message, kind = "") {
  ui.restoreStatus.textContent = message;
  ui.restoreStatus.dataset.kind = kind;
}

function renderRouteSummary() {
  ui.routeChinaAction.textContent = ui.directChina.checked ? "直连" : "代理";
  ui.routeAdsAction.textContent = ui.blockAds.checked ? "拦截" : "关闭";
  ui.routeAdsTarget.textContent = ui.blockAds.checked ? "广告请求" : "广告拦截";
}

function formatErrorMessage(message) {
  const text = String(message || "无法解析这条链接。")
    .replace(/(?:vless|vmess|trojan|ss):\/\/\S+/gi, "节点链接")
    .replace(/[A-Fa-f0-9-]{32,}/g, "敏感字段")
    .slice(0, 180);
  return text || "无法解析这条链接。";
}

function setPreviewStale() {
  preview = null;
  ui.previewState.textContent = "尚未生成";
  ui.previewState.removeAttribute("data-state");
  ui.copyYaml.disabled = true;
  ui.downloadYaml.disabled = true;
  ui.summary.textContent = "输入或路由选项变化后，请重新生成预览。";
  ui.nodes.replaceChildren();
  ui.empty.hidden = false;
  ui.nodes.hidden = true;
  ui.count.textContent = "0";
  ui.yaml.replaceChildren(document.createTextNode("请重新生成配置预览。"));
  ui.errors.hidden = true;
  syncManagementControls();
  setStatus("");
}

function renderErrors(errors, validCount) {
  ui.errors.replaceChildren();
  if (!errors.length) {
    ui.errors.hidden = true;
    return;
  }

  const heading = document.createElement("strong");
  heading.textContent =
    validCount > 0
      ? `有 ${errors.length} 行未能解析；预览只包含 ${validCount} 条有效节点。`
      : `${errors.length} 行未能解析，请修正后再试。`;
  const list = document.createElement("ul");

  for (const error of errors) {
    const item = document.createElement("li");
    const line = Number.isInteger(error.line) ? `第 ${error.line} 行：` : "";
    item.textContent = `${line}${formatErrorMessage(error.message)}`;
    list.append(item);
  }

  ui.errors.append(heading, list);
  ui.errors.hidden = false;
}

function renderNodes(nodes) {
  ui.nodes.replaceChildren();
  for (const node of nodes) {
    const item = document.createElement("li");
    item.className = "node-row";

    const main = document.createElement("div");
    main.className = "node-main";
    const protocol = document.createElement("span");
    protocol.className = "protocol-tag";
    protocol.textContent = String(node.type || "节点").toUpperCase();
    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = node.name || "未命名节点";
    main.append(protocol, name);

    const address = document.createElement("span");
    address.className = "node-address";
    const safeServer = String(node.server || "").replace(/[\r\n]/g, "").slice(0, 120);
    const safePort = Number.isInteger(Number(node.port)) ? String(node.port) : "";
    address.textContent = safeServer ? `${safeServer}${safePort ? `:${safePort}` : ""}` : "";

    item.append(main, address);
    ui.nodes.append(item);
  }
  ui.empty.hidden = nodes.length > 0;
  ui.nodes.hidden = nodes.length === 0;
}

function tabTo(tab) {
  const showNodes = tab === "nodes";
  ui.nodesTab.classList.toggle("is-current", showNodes);
  ui.yamlTab.classList.toggle("is-current", !showNodes);
  ui.nodesTab.setAttribute("aria-selected", String(showNodes));
  ui.yamlTab.setAttribute("aria-selected", String(!showNodes));
  ui.nodesTab.tabIndex = showNodes ? 0 : -1;
  ui.yamlTab.tabIndex = showNodes ? -1 : 0;
  ui.nodesView.hidden = !showNodes;
  ui.yamlView.hidden = showNodes;
}

function currentFingerprint() {
  return JSON.stringify([
    ui.links.value,
    ui.name.value.trim(),
    ui.directChina.checked,
    ui.blockAds.checked,
  ]);
}

function currentPreview() {
  return Boolean(preview && preview.fingerprint === currentFingerprint());
}

function syncManagementControls() {
  ui.publish.disabled = managementBusy || Boolean(subscription) || !currentPreview();
  ui.update.disabled = managementBusy || !subscription || !currentPreview();
  ui.deleteToggle.disabled = managementBusy || !subscription;
  ui.deleteConfirm.disabled =
    managementBusy || !subscription || ui.deleteInput.value.trim() !== "删除订阅";
  ui.restoreButton.disabled = managementBusy;
  ui.restoreId.disabled = managementBusy;
  ui.restoreToken.disabled = managementBusy;
  ui.retryRead.disabled = managementBusy || !subscription;
  ui.confirmation.disabled = managementBusy || !subscription;
  for (const control of [
    ui.publish,
    ui.update,
    ui.deleteConfirm,
    ui.restoreButton,
    ui.retryRead,
    ui.confirmation,
  ]) {
    control.setAttribute("aria-busy", String(managementBusy));
  }
}

function setManagementBusy(busy) {
  managementBusy = busy;
  syncManagementControls();
}

async function generatePreview() {
  const raw = ui.links.value.trim();
  ui.generate.disabled = true;
  ui.generate.setAttribute("aria-busy", "true");
  ui.previewState.textContent = "正在本地解析";
  ui.previewState.removeAttribute("data-state");
  ui.errors.hidden = true;
  setStatus("");

  try {
    const parsed = parseLinks(raw);
    if (!parsed.nodes.length) {
      preview = null;
      renderNodes([]);
      renderErrors(parsed.errors || [], 0);
      ui.count.textContent = "0";
      ui.summary.textContent = "没有可用节点；请检查链接格式。";
      ui.yaml.replaceChildren(document.createTextNode("没有生成配置。"));
      ui.previewState.textContent = "无法生成";
      ui.publish.disabled = true;
      ui.copyYaml.disabled = true;
      ui.downloadYaml.disabled = true;
      setStatus("至少需要一条有效节点，才能生成配置。", "error");
      return;
    }

    const built = buildConfig(parsed.nodes, {
      blockAds: ui.blockAds.checked,
      directChina: ui.directChina.checked,
      name: ui.name.value.trim() || "我的节点",
    });
    preview = {
      nodes: parsed.nodes,
      errors: parsed.errors || [],
      config: built.config,
      yaml: built.yaml,
      fingerprint: currentFingerprint(),
    };

    renderNodes(preview.nodes);
    renderErrors(preview.errors, preview.nodes.length);
    ui.yaml.replaceChildren(document.createTextNode(preview.yaml));
    ui.count.textContent = String(preview.nodes.length);
    const errorSuffix = preview.errors.length
      ? `，${preview.errors.length} 行未通过`
      : "";
    ui.summary.textContent = `${preview.nodes.length} 条有效节点${errorSuffix}`;
    ui.previewState.textContent = "预览已更新";
    ui.previewState.dataset.state = "ready";
    ui.copyYaml.disabled = false;
    ui.downloadYaml.disabled = false;
    syncManagementControls();
    setStatus(
      preview.errors.length
        ? `配置仅包含 ${preview.nodes.length} 条有效节点。`
        : "配置已在本地生成。",
      "success",
    );
  } catch {
    preview = null;
    renderNodes([]);
    ui.count.textContent = "0";
    ui.yaml.replaceChildren(document.createTextNode("配置生成失败。"));
    ui.summary.textContent = "配置生成失败，请检查输入和选项。";
    ui.previewState.textContent = "无法生成";
    ui.previewState.removeAttribute("data-state");
    ui.publish.disabled = true;
    ui.copyYaml.disabled = true;
    ui.downloadYaml.disabled = true;
    setStatus("无法生成有效配置，请检查节点链接。", "error");
  } finally {
    ui.generate.disabled = false;
    ui.generate.removeAttribute("aria-busy");
    syncManagementControls();
  }
}

function downloadText(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

async function copyText(text, label) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    setStatus(`${label}已复制。`, "success");
  } catch {
    setStatus(`无法自动复制${label}，请选中并手动复制。`, "error");
  }
}

function localScope() {
  const host = window.location.hostname;
  return window.location.protocol !== "https:" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1";
}

function setHostingScope(url) {
  const isLocal = localScope() || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(url);
  ui.subscriptionScope.textContent = isLocal
    ? "本机订阅，仅当前设备可访问；公网使用需部署 HTTPS 服务。"
    : "此地址可读取 Cloudflare KV 中的 YAML，内容含节点凭据；取得地址的人即可读取。删除在全球生效可能延迟。";
}

function sameOriginPath(rawUrl) {
  const serviceUrl = new URL(rawUrl, window.location.origin);
  return new URL(`${serviceUrl.pathname}${serviceUrl.search}`, window.location.origin).href;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
  let payload = null;
  if (response.status !== 204) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    }
  }
  if (!response.ok) {
    throw new Error(payload?.error || "请求未完成，请稍后重试。");
  }
  return { response, payload };
}

function subscriptionPath(id) {
  return `/sub/${encodeURIComponent(id)}.yaml`;
}

async function confirmSubscriptionReadable(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("暂时无法读取订阅，请保留管理凭据并重试确认。");
  if (!(response.headers.get("content-type") || "").toLowerCase().includes("yaml")) {
    throw new Error("订阅地址返回了意外内容，请保留管理凭据并重试确认。");
  }
  const yaml = await response.text();
  if (!yaml.includes("proxies:") || !yaml.includes("proxy-groups:")) {
    throw new Error("订阅地址未返回完整配置，请保留管理凭据并重试确认。");
  }
  return yaml;
}

function showSubscription({
  id,
  url,
  manageToken,
  expectedYaml,
  confirmed = false,
}) {
  subscription = { id, url, manageToken, expectedYaml };
  ui.subscriptionUrl.value = url;
  ui.manageToken.value = manageToken;
  ui.subscriptionResult.hidden = false;
  ui.confirmation.textContent = confirmed ? "地址读取已确认" : "尚未确认读取";
  ui.confirmation.dataset.confirmed = String(confirmed);
  ui.hostingNotice.hidden = true;
  ui.retryRead.hidden = true;
  ui.deletePanel.hidden = true;
  ui.deleteInput.value = "";
  ui.deleteConfirm.disabled = true;
  setHostingScope(url);
  syncManagementControls();
}

async function publishSubscription() {
  if (managementBusy || subscription || !currentPreview()) return;
  const expectedYaml = preview.yaml;
  const name = ui.name.value.trim() || "我的节点";
  setManagementBusy(true);
  ui.publish.setAttribute("aria-busy", "true");
  ui.hostingNotice.hidden = true;
  setStatus("正在发布生成后的 YAML…");

  try {
    const { payload } = await requestJson("/api/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml: expectedYaml, name }),
    });

    if (!payload?.id || !payload?.url || !payload?.manageToken) {
      throw new Error("服务返回的信息不完整，请查看服务端状态。");
    }
    const url = sameOriginPath(payload.url);
    showSubscription({
      id: payload.id,
      url,
      manageToken: payload.manageToken,
      expectedYaml,
      confirmed: false,
    });
    setStatus("发布请求已完成，正在确认订阅地址…");

    try {
      const receivedYaml = await confirmSubscriptionReadable(url);
      if (receivedYaml !== expectedYaml) {
        throw new Error("订阅更新仍在传播，当前读取到的内容与本次发布不同。请稍后重试确认。");
      }
      ui.confirmation.textContent = "地址读取已确认";
      ui.confirmation.dataset.confirmed = "true";
      setStatus("订阅已发布，地址已返回 YAML。", "success");
    } catch (error) {
      ui.hostingNoticeText.textContent = `${error.message} 管理凭据已保留；可重试地址确认，无需重新发布。`;
      ui.hostingNotice.hidden = false;
      ui.retryRead.hidden = false;
      setStatus("已取得订阅和管理凭据，但读取确认尚未完成。", "error");
    }
  } catch (error) {
    setStatus(error.message || "发布失败，当前本地预览仍可使用。", "error");
  } finally {
    setManagementBusy(false);
    ui.publish.removeAttribute("aria-busy");
  }
}

async function retryReadConfirmation() {
  if (!subscription || managementBusy) return;
  const { url, expectedYaml } = subscription;
  setManagementBusy(true);
  ui.confirmation.textContent = "正在确认";
  ui.confirmation.removeAttribute("data-confirmed");
  try {
    const receivedYaml = await confirmSubscriptionReadable(url);
    if (expectedYaml !== undefined && receivedYaml !== expectedYaml) {
      throw new Error("存储变更可能仍在传播，当前读取到的内容与最近一次提交不同。请稍后重试。");
    }
    ui.confirmation.textContent =
      expectedYaml === undefined ? "地址读取已确认" : "提交内容已确认";
    ui.confirmation.dataset.confirmed = "true";
    ui.hostingNotice.hidden = true;
    setStatus("订阅地址现在可以读取 YAML。", "success");
  } catch (error) {
    ui.hostingNoticeText.textContent = `${error.message} 管理凭据仍保留在此页面。`;
    ui.hostingNotice.hidden = false;
    ui.retryRead.hidden = false;
    setStatus("读取尚未确认，可稍后重试。", "error");
  } finally {
    setManagementBusy(false);
  }
}

async function updateSubscription() {
  if (!subscription || !currentPreview() || managementBusy) return;
  const { id, manageToken, url: currentUrl } = subscription;
  const expectedYaml = preview.yaml;
  const name = ui.name.value.trim() || "我的节点";
  setManagementBusy(true);
  ui.confirmation.removeAttribute("data-confirmed");
  ui.confirmation.textContent = "正在提交更新";
  setStatus("正在更新已有订阅…");
  try {
    const { payload } = await requestJson(
      `/api/subscriptions/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${manageToken}`,
        },
        body: JSON.stringify({ yaml: expectedYaml, name }),
      },
    );
    subscription = {
      ...subscription,
      id,
      manageToken,
      url: payload?.url ? sameOriginPath(payload.url) : currentUrl,
      expectedYaml,
    };
    ui.subscriptionUrl.value = subscription.url;
    ui.confirmation.textContent = "等待更新传播";
    ui.confirmation.removeAttribute("data-confirmed");
    setHostingScope(subscription.url);
    setStatus("更新请求已完成；存储变更可能需要时间传播。", "success");
    try {
      const receivedYaml = await confirmSubscriptionReadable(subscription.url);
      if (receivedYaml !== expectedYaml) {
        throw new Error("存储变更可能仍在传播，当前读取到的内容与本次更新不同。请稍后重试确认。");
      }
      ui.confirmation.textContent = "更新内容可读取";
      ui.confirmation.dataset.confirmed = "true";
    } catch (error) {
      ui.hostingNoticeText.textContent = error.message;
      ui.hostingNotice.hidden = false;
      ui.retryRead.hidden = false;
    }
  } catch (error) {
    ui.confirmation.textContent = "更新未提交";
    setStatus(error.message || "更新失败；可检查管理凭据后重试。", "error");
  } finally {
    setManagementBusy(false);
  }
}

async function restoreManagement() {
  if (managementBusy) return;
  const id = ui.restoreId.value.trim();
  const manageToken = ui.restoreToken.value.trim();
  if (!id || !manageToken) {
    setRestoreStatus("请填写订阅 ID 和管理令牌。", "error");
    return;
  }
  const url = new URL(subscriptionPath(id), window.location.origin).href;
  setManagementBusy(true);
  setRestoreStatus("正在验证订阅地址…");
  try {
    await confirmSubscriptionReadable(url);
    showSubscription({ id, url, manageToken, confirmed: true });
    ui.subscriptionResult.hidden = false;
    ui.subscriptionTitle.focus();
    setRestoreStatus(
      "订阅地址可读取。服务会在更新或删除时验证管理令牌。",
    );
    ui.subscriptionResult.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    setRestoreStatus(
      error.message || "无法读取订阅；请检查 ID、服务状态和访问权限。",
      "error",
    );
  } finally {
    setManagementBusy(false);
  }
}

async function deleteSubscription() {
  if (
    managementBusy ||
    !subscription ||
    ui.deleteInput.value.trim() !== "删除订阅"
  ) return;
  const { id, manageToken } = subscription;
  setManagementBusy(true);
  setStatus("正在请求删除订阅…");
  try {
    await requestJson(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${manageToken}` },
    });
    subscription = null;
    ui.subscriptionResult.hidden = true;
    ui.subscriptionUrl.value = "";
    ui.manageToken.value = "";
    ui.restoreId.value = "";
    ui.restoreToken.value = "";
    ui.hostingNotice.hidden = true;
    ui.retryRead.hidden = true;
    ui.confirmation.removeAttribute("data-confirmed");
    setStatus("删除请求已完成。存储变更可能延迟传播；客户端已有副本和节点凭据不会随之失效。", "success");
  } catch (error) {
    setStatus(error.message || "删除失败，请检查管理凭据后重试。", "error");
  } finally {
    setManagementBusy(false);
  }
}

function downloadManagementCredentials() {
  if (!subscription) return;
  const content = [
    "折流订阅管理凭据",
    "",
    `订阅 ID: ${subscription.id}`,
    `订阅地址: ${subscription.url}`,
    `管理令牌: ${subscription.manageToken}`,
    "",
    "请妥善保管此文件。订阅 YAML 含节点凭据。",
  ].join("\n");
  downloadText("zheliu-subscription-credentials.txt", content, "text/plain;charset=utf-8");
  setStatus("管理凭据文件已下载。", "success");
}

ui.generate.addEventListener("click", generatePreview);
ui.sample.addEventListener("click", () => {
  ui.links.value = SAMPLE_LINKS;
  setPreviewStale();
  ui.links.focus();
});
ui.clear.addEventListener("click", () => {
  ui.links.value = "";
  setPreviewStale();
  ui.links.focus();
});

for (const control of [ui.links, ui.name, ui.directChina, ui.blockAds]) {
  control.addEventListener("input", () => {
    setPreviewStale();
  });
  control.addEventListener("change", () => {
    setPreviewStale();
  });
}

ui.nodesTab.addEventListener("click", () => tabTo("nodes"));
ui.yamlTab.addEventListener("click", () => tabTo("yaml"));
for (const [button, tab] of [
  [ui.nodesTab, "nodes"],
  [ui.yamlTab, "yaml"],
]) {
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "nodes" ? "yaml" : "nodes";
    tabTo(next);
    (next === "nodes" ? ui.nodesTab : ui.yamlTab).focus();
  });
}

ui.copyYaml.addEventListener("click", () => {
  if (currentPreview()) void copyText(preview.yaml, "YAML");
});
ui.downloadYaml.addEventListener("click", () => {
  if (!currentPreview()) return;
  downloadText("clash-config.yaml", preview.yaml, "application/yaml;charset=utf-8");
  setStatus("YAML 文件已下载。", "success");
});
ui.publish.addEventListener("click", publishSubscription);
ui.copyUrl.addEventListener("click", () => {
  if (!subscription) return;
  void copyText(subscription.url, "订阅地址");
});
ui.subscriptionUrl.addEventListener("focus", () => ui.subscriptionUrl.select());
ui.manageToken.addEventListener("focus", () => ui.manageToken.select());
ui.revealToken.addEventListener("click", () => {
  const reveal = ui.manageToken.type === "password";
  ui.manageToken.type = reveal ? "text" : "password";
  ui.revealToken.textContent = reveal ? "隐藏" : "显示";
});
ui.downloadCredentials.addEventListener("click", downloadManagementCredentials);
ui.update.addEventListener("click", updateSubscription);
ui.deleteToggle.addEventListener("click", () => {
  ui.deletePanel.hidden = !ui.deletePanel.hidden;
  if (!ui.deletePanel.hidden) ui.deleteInput.focus();
});
ui.deleteInput.addEventListener("input", () => {
  syncManagementControls();
});
ui.deleteConfirm.addEventListener("click", deleteSubscription);
ui.restoreButton.addEventListener("click", restoreManagement);

ui.retryRead.addEventListener("click", retryReadConfirmation);
ui.confirmation.addEventListener("click", retryReadConfirmation);
ui.directChina.addEventListener("input", renderRouteSummary);
ui.directChina.addEventListener("change", renderRouteSummary);
ui.blockAds.addEventListener("input", renderRouteSummary);
ui.blockAds.addEventListener("change", renderRouteSummary);

ui.publish.disabled = true;
ui.copyYaml.disabled = true;
ui.downloadYaml.disabled = true;
ui.update.disabled = true;
renderRouteSummary();
setManagementBusy(false);
if (localScope()) {
  ui.hostingNoticeText.textContent =
    "本机订阅，仅当前设备可访问；公网使用需部署 HTTPS 服务。";
  ui.hostingNotice.hidden = false;
} else {
  ui.publishDataNotice.textContent =
    "发布会把生成的 YAML（含节点凭据）存入 Cloudflare KV；取得订阅地址的人即可读取。请另存管理令牌，删除在全球生效可能延迟。";
}
