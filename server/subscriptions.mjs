const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 80;
const CREATE_LIMIT = 20;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const REVOCATION_CLEANUP_CURSOR_KEY = "cleanup:revocation-cursor";
const MAX_CLEANUP_PAGE_SIZE = 100;
const encoder = new TextEncoder();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: message }, status);
}

function withNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function randomToken(byteCount = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function digestToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeStringEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readBoundedBody(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RangeError("body too large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("body too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validName(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= MAX_NAME_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function subscriptionDisposition(name) {
  if (typeof name !== "string") return 'inline; filename="subscription.yaml"';
  const safeName = [...new TextDecoder().decode(encoder.encode(name))
    .replace(/[\\/<>:"'|?*\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .trim()
    .replace(/^\.+|\.+$/gu, "")].slice(0, MAX_NAME_LENGTH).join("");
  if (!safeName) return 'inline; filename="subscription.yaml"';
  const asciiName = safeName.replace(/[^\x20-\x7e]/gu, "")
    .replace(/[^A-Za-z0-9 ._-]/gu, "_")
    .trim()
    .replace(/^\.+|\.+$/gu, "") || "subscription";
  const encodedName = encodeURIComponent(safeName)
    .replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function validYaml(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && encoder.encode(value).byteLength <= MAX_BODY_BYTES;
}

function validId(value) {
  return /^[A-Za-z0-9_-]{32,64}$/u.test(value);
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/u.exec(authorization);
  return match?.[1] ?? null;
}

function sameOrigin(request, url) {
  return request.headers.get("origin") === url.origin;
}

async function readInput(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: errorResponse(415, "Expected application/json.") };
  }
  let raw;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    return {
      error: error instanceof RangeError
        ? errorResponse(413, "Request body is too large.")
        : errorResponse(400, "Request body must be valid UTF-8."),
    };
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: errorResponse(400, "Request body must be valid JSON.") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: errorResponse(400, "Request body must be a JSON object.") };
  }
  if (!validName(value.name)) {
    return { error: errorResponse(400, `Name must contain 1-${MAX_NAME_LENGTH} characters.`) };
  }
  if (!validYaml(value.yaml)) {
    return { error: errorResponse(400, "YAML must be non-empty and at most 256 KiB.") };
  }
  return { value: { name: value.name.trim(), yaml: value.yaml } };
}

async function allowCreate(request, kv) {
  const clientAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
  const addressDigest = (await digestToken(clientAddress)).slice(0, 32);
  const key = `rate:${addressDigest}`;
  const now = Date.now();
  const currentText = await kv.get(key);
  let current = null;
  if (currentText) {
    try {
      current = JSON.parse(currentText);
    } catch {
      current = null;
    }
  }
  const active = current && current.expiresAt > now ? current : { count: 0, expiresAt: now + CREATE_WINDOW_MS };
  if (active.count >= CREATE_LIMIT) return false;
  await kv.put(key, JSON.stringify({ count: active.count + 1, expiresAt: active.expiresAt }), {
    expirationTtl: Math.ceil(CREATE_WINDOW_MS / 1000),
  });
  return true;
}

export function createSubscriptionHandler({ kv, basePath = "/" }) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function" || typeof kv.delete !== "function") {
    throw new TypeError("A KV-compatible storage binding is required.");
  }

  return async function handleSubscriptionRequest(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === `${basePath}api/subscriptions` && request.method === "POST") {
      if (!sameOrigin(request, url)) return errorResponse(403, "Write requests must be same-origin.");
      const input = await readInput(request);
      if (input.error) return input.error;

      let allowed;
      try {
        allowed = await allowCreate(request, kv);
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      if (!allowed) return errorResponse(429, "Subscription creation limit reached. Try again later.");

      const id = randomToken(24);
      const manageToken = randomToken();
      const record = {
        name: input.value.name,
        yaml: input.value.yaml,
        manageHash: await digestToken(manageToken),
      };
      try {
        await kv.put(`subscription:${id}`, JSON.stringify(record));
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      return jsonResponse({
        id,
        url: new URL(`${basePath}sub/${id}.yaml`, url).toString(),
        manageToken,
      }, 201);
    }

    const readMatch = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}sub/([A-Za-z0-9_-]{32,64})\\.yaml$`, "u").exec(pathname);
    if (readMatch && request.method === "GET") {
      let record;
      try {
        const revoked = await kv.get(`revocation:${readMatch[1]}`);
        if (revoked) return errorResponse(404, "Subscription not found.");
        const raw = await kv.get(`subscription:${readMatch[1]}`);
        record = raw ? JSON.parse(raw) : null;
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      if (!record || typeof record.yaml !== "string") return errorResponse(404, "Subscription not found.");
      return withNoStore(new Response(record.yaml, {
        headers: {
          "content-type": "application/yaml; charset=utf-8",
          "content-disposition": subscriptionDisposition(record.name),
        },
      }));
    }

    const manageMatch = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}api/subscriptions/([A-Za-z0-9_-]{32,64})$`, "u").exec(pathname);
    if (manageMatch && (request.method === "PUT" || request.method === "DELETE")) {
      if (!sameOrigin(request, url)) return errorResponse(403, "Write requests must be same-origin.");
      const suppliedToken = bearerToken(request);
      if (!suppliedToken) return errorResponse(401, "A valid management token is required.");

      let rawRecord;
      let revoked;
      try {
        revoked = await kv.get(`revocation:${manageMatch[1]}`);
        if (revoked && request.method === "PUT") {
          return errorResponse(404, "Subscription not found.");
        }
        rawRecord = await kv.get(`subscription:${manageMatch[1]}`);
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      if (!rawRecord) return errorResponse(404, "Subscription not found.");

      let record;
      try {
        record = JSON.parse(rawRecord);
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      const suppliedHash = await digestToken(suppliedToken);
      if (!constantTimeStringEqual(record.manageHash ?? "", suppliedHash)) {
        return errorResponse(401, "A valid management token is required.");
      }

      if (request.method === "DELETE") {
        try {
          if (!revoked) await kv.put(`revocation:${manageMatch[1]}`, "1");
          await kv.delete(`subscription:${manageMatch[1]}`);
        } catch {
          return errorResponse(503, "Subscription storage is temporarily unavailable.");
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      const input = await readInput(request);
      if (input.error) return input.error;
      try {
        await kv.put(`subscription:${manageMatch[1]}`, JSON.stringify({
          ...input.value,
          manageHash: record.manageHash,
        }));
        if (await kv.get(`revocation:${manageMatch[1]}`)) {
          await kv.delete(`subscription:${manageMatch[1]}`);
          return errorResponse(409, "Subscription was revoked during the update.");
        }
      } catch {
        return errorResponse(503, "Subscription storage is temporarily unavailable.");
      }
      return jsonResponse({
        id: manageMatch[1],
        url: new URL(`${basePath}sub/${manageMatch[1]}.yaml`, url).toString(),
      });
    }

    return errorResponse(404, "Not found.");
  };
}

export async function cleanupRevokedSubscriptions(kv, { limit = MAX_CLEANUP_PAGE_SIZE } = {}) {
  const pageSize = Math.min(MAX_CLEANUP_PAGE_SIZE, Math.max(1, Math.floor(limit)));
  const cursor = await kv.get(REVOCATION_CLEANUP_CURSOR_KEY);
  const options = { prefix: "revocation:", limit: pageSize };
  if (cursor) options.cursor = cursor;

  const page = await kv.list(options);
  if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== "boolean") {
    throw new TypeError("KV returned an invalid revocation cleanup page.");
  }

  for (const key of page.keys) {
    const id = key.name.slice("revocation:".length);
    if (key.name.startsWith("revocation:") && validId(id)) {
      await kv.delete(`subscription:${id}`);
    }
  }

  if (page.list_complete) {
    await kv.delete(REVOCATION_CLEANUP_CURSOR_KEY);
  } else if (typeof page.cursor === "string" && page.cursor.length > 0) {
    await kv.put(REVOCATION_CLEANUP_CURSOR_KEY, page.cursor);
  } else {
    throw new TypeError("KV omitted the cursor for an incomplete revocation cleanup page.");
  }

  return { checked: page.keys.length, complete: page.list_complete };
}
