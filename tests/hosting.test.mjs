import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupRevokedSubscriptions,
  createSubscriptionHandler,
} from "../server/subscriptions.mjs";

const yaml = "proxies:\n  - name: example\n    type: vless\n";
const origin = "https://converter.example";

class FakeKV {
  values = new Map();
  failPut = false;
  failGet = false;
  failDelete = false;
  pausedGetKey = null;
  readPaused;
  resumeRead;
  staleNullReads = new Map();
  listCalls = [];

  async get(key) {
    if (this.failGet) throw new Error("storage unavailable");
    const staleReadCount = this.staleNullReads.get(key) ?? 0;
    if (staleReadCount > 0) {
      this.staleNullReads.set(key, staleReadCount - 1);
      return null;
    }
    const value = this.values.get(key) ?? null;
    if (key === this.pausedGetKey) {
      this.pausedGetKey = null;
      this.readPaused();
      await new Promise((resolve) => {
        this.resumeRead = resolve;
      });
    }
    return value;
  }

  async put(key, value) {
    if (this.failPut && key.startsWith("subscription:")) throw new Error("storage unavailable");
    this.values.set(key, value);
  }

  async delete(key) {
    if (this.failDelete) throw new Error("storage unavailable");
    this.values.delete(key);
  }

  async list(options) {
    this.listCalls.push({ ...options });
    const names = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort();
    const start = Number(options.cursor ?? 0);
    const end = Math.min(start + options.limit, names.length);
    const listComplete = end >= names.length;
    return {
      keys: names.slice(start, end).map((name) => ({ name })),
      list_complete: listComplete,
      ...(listComplete ? {} : { cursor: String(end) }),
    };
  }

  pauseNextGet(key) {
    this.pausedGetKey = key;
    const ready = new Promise((resolve) => {
      this.readPaused = resolve;
    });
    return {
      ready,
      resume: () => this.resumeRead(),
    };
  }
}

function createHarness(kv = new FakeKV()) {
  const handle = createSubscriptionHandler({ kv });
  return { handle, kv };
}

function jsonRequest(url, method, value, headers = {}) {
  return new Request(url, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

async function createSubscription(handle, value = { name: "Travel", yaml }) {
  const response = await handle(jsonRequest(`${origin}/api/subscriptions`, "POST", value));
  assert.equal(response.status, 201);
  return response.json();
}

test("creates a subscription, returns a read URL, and stores only the management token digest", async () => {
  const { handle, kv } = createHarness();
  const created = await createSubscription(handle);

  assert.match(created.id, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(created.url, `${origin}/sub/${created.id}.yaml`);
  assert.match(created.manageToken, /^[A-Za-z0-9_-]{43}$/u);
  const record = JSON.parse(kv.values.get(`subscription:${created.id}`));
  assert.equal(record.yaml, yaml);
  assert.notEqual(record.manageHash, created.manageToken);
  assert.equal(record.manageToken, undefined);

  const fetched = await handle(new Request(created.url));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("cache-control"), "no-store");
  assert.equal(fetched.headers.get("content-type"), "application/yaml; charset=utf-8");
  assert.equal(fetched.headers.get("content-disposition"), "inline; filename=\"Travel\"; filename*=UTF-8''Travel");
  assert.equal(await fetched.text(), yaml);
});

test("uses UTF-8 names and safe filename fallbacks for subscription downloads", async () => {
  const { handle } = createHarness();
  const unicode = await createSubscription(handle, { name: "中文😀", yaml });
  const unicodeResponse = await handle(new Request(unicode.url));
  assert.equal(unicodeResponse.headers.get("content-disposition"),
    "inline; filename=\"subscription\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%F0%9F%98%80");

  const special = await createSubscription(handle, { name: 'A/B\\C "VIP"; O\'\'Reilly', yaml });
  const specialResponse = await handle(new Request(special.url));
  assert.equal(specialResponse.headers.get("content-disposition"),
    "inline; filename=\"A_B_C _VIP__ O__Reilly\"; filename*=UTF-8''A_B_C%20_VIP_%3B%20O__Reilly");
  assert.equal(specialResponse.headers.get("cache-control"), "no-store");
});

test("replaces bidirectional controls in download names while keeping Chinese and emoji", async () => {
  const { handle } = createHarness();
  const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const created = await createSubscription(handle, { name: `中文😀A${controls}VIP`, yaml });
  const fetched = await handle(new Request(created.url));
  const underscores = "_".repeat([...controls].length);
  assert.equal(fetched.headers.get("content-disposition"),
    `inline; filename="A${underscores}VIP"; filename*=UTF-8''%E4%B8%AD%E6%96%87%F0%9F%98%80A${underscores}VIP`);
});

test("falls back for legacy records without a name and sanitizes stored control characters", async () => {
  const { handle, kv } = createHarness();
  const created = await createSubscription(handle);
  const recordKey = `subscription:${created.id}`;
  const legacyRecord = JSON.parse(kv.values.get(recordKey));
  delete legacyRecord.name;
  kv.values.set(recordKey, JSON.stringify(legacyRecord));
  const legacy = await handle(new Request(created.url));
  assert.equal(legacy.headers.get("content-disposition"), 'inline; filename="subscription.yaml"');

  legacyRecord.name = 'bad\r\nInjected: yes/../../secret"';
  kv.values.set(recordKey, JSON.stringify(legacyRecord));
  const malicious = await handle(new Request(created.url));
  const disposition = malicious.headers.get("content-disposition");
  assert.ok(disposition);
  assert.doesNotMatch(disposition, /[\r\n\\/]/u);
  assert.equal(disposition,
    "inline; filename=\"bad__Injected_ yes_.._.._secret_\"; filename*=UTF-8''bad__Injected_%20yes_.._.._secret_");
});

test("rejects cross-origin create, update, and delete requests", async () => {
  const { handle } = createHarness();
  const crossOrigin = jsonRequest(`${origin}/api/subscriptions`, "POST", { name: "x", yaml }, {
    origin: "https://attacker.example",
  });
  assert.equal((await handle(crossOrigin)).status, 403);

  const created = await createSubscription(handle);
  const update = jsonRequest(`${origin}/api/subscriptions/${created.id}`, "PUT", { name: "x", yaml }, {
    origin: "https://attacker.example",
    authorization: `Bearer ${created.manageToken}`,
  });
  assert.equal((await handle(update)).status, 403);
  const deletion = new Request(`${origin}/api/subscriptions/${created.id}`, {
    method: "DELETE",
    headers: {
      origin: "https://attacker.example",
      authorization: `Bearer ${created.manageToken}`,
    },
  });
  assert.equal((await handle(deletion)).status, 403);
});

test("read credentials cannot update or delete and invalid management tokens are rejected", async () => {
  const { handle } = createHarness();
  const created = await createSubscription(handle);
  const update = jsonRequest(`${origin}/api/subscriptions/${created.id}`, "PUT", { name: "Changed", yaml }, {
    authorization: `Bearer ${created.id}`,
  });
  assert.equal((await handle(update)).status, 401);
  const deletion = new Request(`${origin}/api/subscriptions/${created.id}`, {
    method: "DELETE",
    headers: { origin, authorization: "Bearer incorrect-token-value-that-is-long-enough" },
  });
  assert.equal((await handle(deletion)).status, 401);
});

test("management token updates the existing read URL and deletes the subscription", async () => {
  const { handle } = createHarness();
  const created = await createSubscription(handle);
  const changedYaml = "proxies: []\n";
  const updated = await handle(jsonRequest(
    `${origin}/api/subscriptions/${created.id}`,
    "PUT",
    { name: "New name", yaml: changedYaml },
    { authorization: `Bearer ${created.manageToken}` },
  ));
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), {
    id: created.id,
    url: `${origin}/sub/${created.id}.yaml`,
  });

  const fetched = await handle(new Request(created.url));
  assert.equal(fetched.headers.get("content-disposition"), "inline; filename=\"New name\"; filename*=UTF-8''New%20name");
  assert.equal(fetched.headers.get("cache-control"), "no-store");
  assert.equal(await fetched.text(), changedYaml);
  const deleted = await handle(new Request(`${origin}/api/subscriptions/${created.id}`, {
    method: "DELETE",
    headers: { origin, authorization: `Bearer ${created.manageToken}` },
  }));
  assert.equal(deleted.status, 204);
  assert.equal((await handle(new Request(created.url))).status, 404);
});

test("a late update after deletion cannot make a revoked subscription readable again", async () => {
  const kv = new FakeKV();
  const { handle } = createHarness(kv);
  const created = await createSubscription(handle);
  const recordKey = `subscription:${created.id}`;
  const readGate = kv.pauseNextGet(recordKey);

  const updatePromise = handle(jsonRequest(
    `${origin}/api/subscriptions/${created.id}`,
    "PUT",
    { name: "Late update", yaml: "proxies: []\n" },
    { authorization: `Bearer ${created.manageToken}` },
  ));
  await readGate.ready;

  const deleted = await handle(new Request(`${origin}/api/subscriptions/${created.id}`, {
    method: "DELETE",
    headers: { origin, authorization: `Bearer ${created.manageToken}` },
  }));
  assert.equal(deleted.status, 204);
  assert.equal(kv.values.get(`revocation:${created.id}`), "1");
  assert.equal(kv.values.has(recordKey), false);

  readGate.resume();
  assert.equal((await updatePromise).status, 409);
  assert.equal(kv.values.has(recordKey), false);
  assert.equal((await handle(new Request(created.url))).status, 404);
});

test("paged cleanup removes late revoked records and leaves active records intact", async () => {
  const kv = new FakeKV();
  const { handle } = createHarness(kv);
  const active = await createSubscription(handle, { name: "Active", yaml });
  const revoked = await createSubscription(handle, { name: "Revoked", yaml });
  const recordKey = `subscription:${revoked.id}`;
  const readGate = kv.pauseNextGet(recordKey);

  const updatePromise = handle(jsonRequest(
    `${origin}/api/subscriptions/${revoked.id}`,
    "PUT",
    { name: "Late update", yaml: "proxies: []\n" },
    { authorization: `Bearer ${revoked.manageToken}` },
  ));
  await readGate.ready;
  const deleted = await handle(new Request(`${origin}/api/subscriptions/${revoked.id}`, {
    method: "DELETE",
    headers: { origin, authorization: `Bearer ${revoked.manageToken}` },
  }));
  assert.equal(deleted.status, 204);

  kv.staleNullReads.set(`revocation:${revoked.id}`, 1);
  readGate.resume();
  assert.equal((await updatePromise).status, 200);
  assert.equal(kv.values.has(recordKey), true);

  for (const id of ["A".repeat(32), "B".repeat(32)]) {
    await kv.put(`revocation:${id}`, "1");
    await kv.put(`subscription:${id}`, JSON.stringify({ yaml, manageHash: "unused" }));
  }

  const firstPage = await cleanupRevokedSubscriptions(kv, { limit: 1 });
  assert.deepEqual(firstPage, { checked: 1, complete: false });
  assert.equal(kv.listCalls[0].limit, 1);
  assert.equal(kv.values.has("cleanup:revocation-cursor"), true);

  const secondPage = await cleanupRevokedSubscriptions(kv, { limit: 1 });
  assert.deepEqual(secondPage, { checked: 1, complete: false });
  assert.equal(kv.listCalls[1].cursor, "1");
  assert.equal(kv.values.has("cleanup:revocation-cursor"), true);

  const finalPage = await cleanupRevokedSubscriptions(kv, { limit: 1 });
  assert.deepEqual(finalPage, { checked: 1, complete: true });
  assert.equal(kv.values.has("cleanup:revocation-cursor"), false);
  assert.equal(kv.values.has(recordKey), false);
  assert.equal(kv.values.has(`subscription:${active.id}`), true);
  assert.equal(kv.values.has(`subscription:${"A".repeat(32)}`), false);
  assert.equal(kv.values.has(`subscription:${"B".repeat(32)}`), false);
});

test("rejects oversized, empty, malformed, and invalidly named input", async () => {
  const { handle } = createHarness();
  const tooLarge = jsonRequest(`${origin}/api/subscriptions`, "POST", {
    name: "Travel",
    yaml: `x: ${"a".repeat(256 * 1024)}`,
  });
  assert.equal((await handle(tooLarge)).status, 413);
  assert.equal((await handle(jsonRequest(
    `${origin}/api/subscriptions`,
    "POST",
    { name: " ", yaml },
  ))).status, 400);
  assert.equal((await handle(jsonRequest(
    `${origin}/api/subscriptions`,
    "POST",
    { name: "Travel", yaml: "" },
  ))).status, 400);
  const wrongType = new Request(`${origin}/api/subscriptions`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain" },
    body: "secret",
  });
  assert.equal((await handle(wrongType)).status, 415);
  const oversizedHeader = new Request(`${origin}/api/subscriptions`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "content-length": "300000" },
    body: "{}",
  });
  assert.equal((await handle(oversizedHeader)).status, 413);
});

test("limits anonymous subscription creation to 20 per client per hour", async () => {
  const { handle } = createHarness();
  for (let index = 0; index < 20; index += 1) {
    const response = await handle(jsonRequest(
      `${origin}/api/subscriptions`,
      "POST",
      { name: `Subscription ${index}`, yaml },
    ));
    assert.equal(response.status, 201);
  }
  const limited = await handle(jsonRequest(
    `${origin}/api/subscriptions`,
    "POST",
    { name: "Over limit", yaml },
  ));
  assert.equal(limited.status, 429);
});

test("reports storage failures without exposing stored content", async () => {
  const { handle, kv } = createHarness();
  kv.failPut = true;
  const createResponse = await handle(jsonRequest(
    `${origin}/api/subscriptions`,
    "POST",
    { name: "Travel", yaml },
  ));
  assert.equal(createResponse.status, 503);
  assert.doesNotMatch(await createResponse.text(), /proxies|Travel/u);

  kv.failPut = false;
  const created = await createSubscription(handle);
  kv.failGet = true;
  assert.equal((await handle(new Request(created.url))).status, 503);
  kv.failGet = false;
  kv.failDelete = true;
  const deleteResponse = await handle(new Request(`${origin}/api/subscriptions/${created.id}`, {
    method: "DELETE",
    headers: { origin, authorization: `Bearer ${created.manageToken}` },
  }));
  assert.equal(deleteResponse.status, 503);
});

test("unknown routes and malformed subscription ids return not found", async () => {
  const { handle } = createHarness();
  assert.equal((await handle(new Request(`${origin}/other`))).status, 404);
  assert.equal((await handle(new Request(`${origin}/sub/not-an-id.yaml`))).status, 404);
});
