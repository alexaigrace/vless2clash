import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubscriptionHandler } from "./subscriptions.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = path.join(projectRoot, ".local-data");
const dataFile = path.join(dataDirectory, "subscriptions.json");
const port = 8787;
const devOrigin = "http://127.0.0.1:5173";
let writeQueue = Promise.resolve();

async function readStore() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const kv = {
  async get(key) {
    const store = await readStore();
    return typeof store[key] === "string" ? store[key] : null;
  },
  async put(key, value) {
    const operation = writeQueue.then(async () => {
      const store = await readStore();
      store[key] = value;
      await mkdir(dataDirectory, { recursive: true });
      const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(store), { mode: 0o600 });
      await rename(temporaryFile, dataFile);
    });
    writeQueue = operation.catch(() => {});
    await operation;
  },
  async delete(key) {
    const operation = writeQueue.then(async () => {
      const store = await readStore();
      delete store[key];
      await mkdir(dataDirectory, { recursive: true });
      const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(store), { mode: 0o600 });
      await rename(temporaryFile, dataFile);
    });
    writeQueue = operation.catch(() => {});
    await operation;
  },
};

const handle = createSubscriptionHandler({ kv });

function toWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = toWebHeaders(incoming.headers);
    headers.set("cf-connecting-ip", incoming.socket.remoteAddress ?? "unknown");
    const requestUrl = new URL(incoming.url ?? "/", devOrigin);
    const body = ["GET", "HEAD"].includes(incoming.method ?? "GET")
      ? undefined
      : Readable.toWeb(incoming);
    const request = new Request(requestUrl, {
      method: incoming.method,
      headers,
      body,
      ...(body ? { duplex: "half" } : {}),
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      outgoing.end();
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) await new Promise((resolve) => outgoing.once("drain", resolve));
    }
    outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "cache-control": "no-store" });
    outgoing.end("Internal server error.");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local subscription API listening at http://127.0.0.1:${port}`);
});

function shutDown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
