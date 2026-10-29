import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { buildConfig, parseLinks, SAMPLE_LINKS } from "../src/lib/engine.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDir = path.join(root, "artifacts", "qa");
const workDir = path.join(root, ".cache", "mihomo-check");
const mihomo =
  process.env.MIHOMO_BIN ||
  "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo";
const report = [];
let sinkServer;
let socksServer;
const mihomoProcesses = new Set();

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function runCore(args, { cwd = workDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(mihomo, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Mihomo exited (${signal ?? code}):\n${output}`));
    });
  });
}

function launchCore(configPath, dataDir) {
  const child = spawn(mihomo, ["-d", dataDir, "-f", configPath], {
    cwd: dataDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  mihomoProcesses.add(child);
  child.once("exit", () => mihomoProcesses.delete(child));
  return {
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function proxyRequest(proxyPort, target, timeoutMs = 900) {
  return new Promise((resolve) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "GET",
      path: `http://${target}/qa`,
      headers: { host: target },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, error: null }));
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", (error) => resolve({ status: null, error: error.message }));
    request.end();
  });
}

function makeRuntimeConfig(config, { controllerPort, mixedPort, dnsPort, socksPort, ipFixture }) {
  const runtime = structuredClone(config);
  runtime["mixed-port"] = mixedPort;
  runtime["external-controller"] = `127.0.0.1:${controllerPort}`;
  runtime["log-level"] = "info";
  runtime["allow-lan"] = false;
  const generatedNodeNames = new Set(runtime.proxies.map(({ name }) => name));
  runtime.proxies = [{
    name: "LOCAL-SOCKS-MOCK",
    type: "socks5",
    server: "127.0.0.1",
    port: socksPort,
    udp: false,
  }];
  for (const group of runtime["proxy-groups"]) {
    group.proxies = [...new Set(group.proxies.map((member) =>
      generatedNodeNames.has(member) ? "LOCAL-SOCKS-MOCK" : member
    ))];
  }
  runtime.hosts = {
    "cn.fixture.test": "198.18.0.2",
    "cn-ip.fixture.test": "198.18.0.2",
    "ad.fixture.test": "198.18.0.2",
    "foreign.fixture.test": "192.0.2.2",
    "private.fixture.test": "198.18.0.2",
  };
  runtime.dns = {
    enable: true,
    listen: `127.0.0.1:${dnsPort}`,
    ipv6: false,
    "enhanced-mode": "redir-host",
    "use-hosts": true,
    "use-system-hosts": false,
    "default-nameserver": ["127.0.0.1"],
    nameserver: ["127.0.0.1"],
  };
  for (const [name, payload] of Object.entries({
    ads: ["ad.fixture.test"],
    private: ["private.fixture.test"],
    cn: ["cn.fixture.test"],
    cn_ip: [ipFixture],
  })) {
    runtime["rule-providers"][name] = {
      type: "inline",
      behavior: name === "cn_ip" ? "ipcidr" : "domain",
      payload,
    };
  }
  return runtime;
}

async function createMockSocks() {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) return;
        buffer = buffer.subarray(2 + methodCount);
        stage = 1;
        socket.write(Buffer.from([5, 0]));
      }
      if (stage !== 1 || buffer.length < 4) return;
      const atyp = buffer[3];
      let addressLength;
      let host;
      if (atyp === 1 && buffer.length >= 10) {
        addressLength = 4;
        host = [...buffer.subarray(4, 8)].join(".");
      } else if (atyp === 3 && buffer.length >= 5) {
        addressLength = buffer[4];
        if (buffer.length < 7 + addressLength) return;
        host = buffer.subarray(5, 5 + addressLength).toString();
      } else {
        return;
      }
      const portOffset = atyp === 3 ? 5 + addressLength : 8;
      if (buffer.length < portOffset + 2) return;
      const port = buffer.readUInt16BE(portOffset);
      seen.push({ host, port });
      stage = 2;
      socket.write(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port, seen };
}

async function runRuntimeCase(name, { baseConfig, ipFixture }) {
  const dataDir = path.join(workDir, name);
  await mkdir(dataDir, { recursive: true });
  const controllerPort = await availablePort();
  const mixedPort = await availablePort();
  const dnsPort = await availablePort();
  const config = structuredClone(baseConfig);
  const runtime = makeRuntimeConfig(config, {
    controllerPort,
    mixedPort,
    dnsPort,
    socksPort: socksServer.port,
    ipFixture,
  });
  const configPath = path.join(dataDir, "config.yaml");
  await writeFile(configPath, stringify(runtime), { mode: 0o600 });
  await runCore(["-t", "-d", dataDir, "-f", configPath], { cwd: dataDir });

  const core = launchCore(configPath, dataDir);
  try {
    await waitFor(async () => {
      if (core.child.exitCode !== null) {
        throw new Error(`${name}: Mihomo exited early:\n${core.output()}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${controllerPort}/version`);
        return response.ok;
      } catch {
        return false;
      }
    }, `${name}: Mihomo controller did not start`);

    for (const [groupName, expectedSelection] of [["直连", "DIRECT"], ["广告拦截", "REJECT"]]) {
      const response = await fetch(`http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent(groupName)}`);
      assert.equal(response.status, 200, `${groupName} should be visible to Mihomo`);
      const group = await response.json();
      assert.equal(group.now, expectedSelection, `${groupName} should keep its built-in default`);
      report.push(`PASS ${name}: ${groupName} selector defaults to ${expectedSelection}`);
    }

    const cases = [
      {
        name: "ad 广告拦截 → REJECT",
        target: `ad.fixture.test:${sinkServer.address().port}`,
        log: /RuleSet\(ads\).*广告拦截\[REJECT\]/u,
      },
      {
        name: "China domain 直连 → DIRECT",
        target: `cn.fixture.test:${sinkServer.address().port}`,
        log: /RuleSet\(cn\).*直连\[DIRECT\]/u,
      },
      {
        name: "China IP 直连 → DIRECT for a domain outside the CN-domain set",
        target: `cn-ip.fixture.test:${sinkServer.address().port}`,
        log: /RuleSet\(cn_ip\).*直连\[DIRECT\]/u,
      },
      {
        name: "LAN fixed DIRECT",
        target: `127.0.0.1:${sinkServer.address().port}`,
        log: /IPCIDR\(127\.0\.0\.0\/8\).*DIRECT/u,
        expectedStatus: 200,
      },
      {
        name: "foreign PROXY",
        target: `foreign.fixture.test:${sinkServer.address().port}`,
        log: /match.*PROXY/iu,
      },
    ];
    for (const item of cases) {
      const result = await proxyRequest(mixedPort, item.target);
      await waitFor(
        () => item.log.test(core.output()),
        `${name}: no Mihomo log evidence for ${item.name}; request=${JSON.stringify(result)}\n${core.output()}`,
      );
      if (item.expectedStatus !== undefined) {
        assert.equal(result.status, item.expectedStatus, `${item.name} should reach the local sink`);
      }
      report.push(`PASS ${name}: ${item.name} matched in Mihomo logs`);
    }

    for (const [groupName, defaultSelection] of [["直连", "DIRECT"], ["广告拦截", "REJECT"]]) {
      const endpoint = `http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent(groupName)}`;
      const selected = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "PROXY" }),
      });
      assert.equal(selected.status, 204, `${groupName} should accept a selection`);
      assert.equal((await (await fetch(endpoint)).json()).now, "PROXY");
      if (groupName === "直连") {
        const logStart = core.output().length;
        const mockDials = socksServer.seen.length;
        const lanResult = await proxyRequest(mixedPort, `127.0.0.1:${sinkServer.address().port}`);
        assert.equal(lanResult.status, 200, "LAN must stay direct after switching the China group");
        await waitFor(
          () => /IPCIDR\(127\.0\.0\.0\/8\).*DIRECT/u.test(core.output().slice(logStart)),
          "LAN did not retain the built-in DIRECT route after switching the China group",
        );
        assert.equal(socksServer.seen.length, mockDials, "LAN must not reach the SOCKS mock");
        report.push(`PASS ${name}: LAN stays DIRECT while 直连 selects PROXY`);
      }
      const restored = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: defaultSelection }),
      });
      assert.equal(restored.status, 204);
      assert.equal((await (await fetch(endpoint)).json()).now, defaultSelection);
      report.push(`PASS ${name}: ${groupName} switched to PROXY and back to ${defaultSelection}`);
    }

    assert.ok(
      runtime.rules.includes("RULE-SET,cn_ip,直连"),
      "generated CN-IP policy should be present and retain the no-no-resolve form",
    );
    assert.ok(
      !runtime.rules.includes("RULE-SET,cn_ip,直连,no-resolve"),
      "generated CN-IP policy must allow Mihomo to resolve the fixture host",
    );
    report.push("PASS generated rule retains RULE-SET,cn_ip,直连 without no-resolve");
  } finally {
    await core.stop();
  }
}

async function validateInlineFixture(name, { baseConfig, ipFixture }) {
  const dataDir = path.join(workDir, name);
  await mkdir(dataDir, { recursive: true });
  const config = makeRuntimeConfig(structuredClone(baseConfig), {
    controllerPort: 46101,
    mixedPort: 46102,
    dnsPort: 46103,
    socksPort: 46104,
    ipFixture,
  });
  const configPath = path.join(dataDir, "preflight.yaml");
  await writeFile(configPath, stringify(config), { mode: 0o600 });
  await runCore(["-t", "-d", dataDir, "-f", configPath], { cwd: dataDir });
  report.push(`PASS ${name}: Mihomo -t accepted inline route fixture`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const version = await runCore(["-v"]);
  const versionLine = version.split("\n").find((line) => /Mihomo Meta v/u.test(line))?.trim();
  assert.ok(versionLine, `Mihomo version output did not contain a version: ${version}`);
  assert.match(versionLine, /Mihomo Meta v1\.19\.32/u);
  report.push(`INFO ${versionLine}`);

  const samples = parseLinks(SAMPLE_LINKS);
  assert.equal(samples.errors.length, 0);
  assert.equal(samples.nodes.length, 4);
  const { config } = buildConfig(samples.nodes, {
    blockAds: true,
    directChina: true,
    name: "QA route fixture",
  });
  assert.ok(config.rules.includes("RULE-SET,cn_ip,直连"));
  assert.ok(!config.rules.includes("RULE-SET,cn_ip,直连,no-resolve"));

  const baseDir = path.join(workDir, "base-config");
  await mkdir(baseDir, { recursive: true });
  const basePath = path.join(baseDir, "generated.yaml");
  for (const blockAds of [false, true]) {
    for (const directChina of [false, true]) {
      await writeFile(basePath, buildConfig(samples.nodes, { blockAds, directChina }).yaml, { mode: 0o600 });
      await runCore(["-t", "-d", baseDir, "-f", basePath], { cwd: baseDir });
      report.push(`PASS generated sample YAML accepted by Mihomo -t (blockAds=${blockAds}, directChina=${directChina})`);
    }
  }

  const reservedNames = [
    "GLOBAL", "PROXY", "DIRECT", "REJECT", "REJECT-DROP", "COMPATIBLE", "PASS", "PASS-RULE",
    "直连", "广告拦截",
  ];
  const reserved = parseLinks(reservedNames.map((name, index) =>
    `trojan://synthetic@node${index}.example.com:443#${encodeURIComponent(name)}`
  ).join("\n"));
  assert.deepEqual(reserved.errors, []);
  assert.ok(reserved.nodes.every(({ name }) => !reservedNames.includes(name)));
  await writeFile(basePath, buildConfig(reserved.nodes).yaml, { mode: 0o600 });
  await runCore(["-t", "-d", baseDir, "-f", basePath], { cwd: baseDir });
  report.push("PASS generated YAML with all reserved-name inputs accepted by Mihomo -t");

  await validateInlineFixture("domain-and-lan", {
    baseConfig: config,
    ipFixture: "198.18.0.0/15",
  });

  sinkServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("local QA sink");
  });
  await new Promise((resolve, reject) => {
    sinkServer.once("error", reject);
    sinkServer.listen(0, "127.0.0.1", resolve);
  });
  socksServer = await createMockSocks();

  await runRuntimeCase("domain-and-lan", {
    baseConfig: config,
    ipFixture: "198.18.0.0/15",
  });

  const expectedProxyPort = sinkServer.address().port;
  const foreignDial = socksServer.seen.find(({ host, port }) =>
    ["foreign.fixture.test", "192.0.2.2"].includes(host) &&
    port === expectedProxyPort
  );
  assert.ok(
    foreignDial,
    `foreign PROXY should reach the local SOCKS mock for foreign.fixture.test or 192.0.2.2:${expectedProxyPort}; observed ${JSON.stringify(socksServer.seen)}`,
  );
  report.push(`PASS foreign PROXY dial reached local SOCKS mock for ${foreignDial.host}:${foreignDial.port}; no real node credentials used`);
  await writeFile(path.join(outputDir, "mihomo-summary.txt"), `${report.join("\n")}\n`);
}

try {
  await main();
  for (const line of report) console.log(line);
  console.log(`Detailed result: ${path.join(outputDir, "mihomo-summary.txt")}`);
} catch (error) {
  report.push(`FAIL ${error.stack || error.message}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "mihomo-summary.txt"), `${report.join("\n")}\n`);
  console.error(report.at(-1));
  process.exitCode = 1;
} finally {
  for (const child of mihomoProcesses) child.kill("SIGTERM");
  if (sinkServer?.listening) {
    await new Promise((resolve) => sinkServer.close(resolve));
  }
  if (socksServer?.server.listening) {
    await new Promise((resolve) => socksServer.server.close(resolve));
  }
}
