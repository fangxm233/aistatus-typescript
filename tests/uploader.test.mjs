import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// input: built UsageUploader / flushUsageUploads / GatewayServer from dist, fetch stubs, local mock HTTP servers, and child processes
// output: regression tests for batched upload payloads, config gating, size/timer/exit flush triggers, retry with stable batch ids, 4xx drops, the 1000-record cap, flush timeouts, and gateway shutdown flushing
// pos: uploader tests protecting the SDK's batched, non-blocking usage upload bridge
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

const DIST_INDEX = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js")).href;
const DIST_GATEWAY = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/gateway/index.js")).href;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG = { name: "Test User", org: "Test Org", email: "test@example.com", uploadEnabled: true };

const sdk = await import(DIST_INDEX);
const { UsageUploader, flushUsageUploads, VERSION } = sdk;

function record(i = 0) {
  return { ts: "2026-04-03T12:34:56.000Z", provider: "anthropic", model: "claude-sonnet-4-6", in: i };
}

// Stubs fetch; calls for other URLs (leftovers from earlier tests) are answered 200 and not recorded.
function stubFetch(url, respond) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== url) return new Response("{}", { status: 200 });
    const call = { input: String(input), init, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      handler(req, res, requests.length);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { requests, baseUrl, close };
}

function reply(res, status, body = { accepted: 1 }) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function runChild(script, env) {
  return new Promise(resolve => {
    const started = Date.now();
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr, elapsed: Date.now() - started }));
  });
}

test("UsageUploader queues records and flushUsageUploads sends one batch payload", async () => {
  const { calls, restore } = stubFetch("https://aistatus.cc/api/usage/upload", () => new Response('{"accepted":1}', { status: 200 }));
  try {
    const uploader = new UsageUploader(CONFIG);
    assert.equal(uploader.upload({ ...record(123), out: 45, cache_creation_in: 6, cache_read_in: 7, cost: 0.01234567, latency_ms: 890 }), undefined);
    assert.equal(calls.length, 0, "upload() must not hit the network synchronously");

    await flushUsageUploads();
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.ok(call.init.signal, "request carries an abort signal");
    assert.match(call.body.batch_id, UUID_RE);
    assert.deepEqual(call.body, {
      batch_id: call.body.batch_id,
      sdk_version: VERSION,
      records: [{
        ts: "2026-04-03T12:34:56.000Z",
        name: "Test User",
        organization: "Test Org",
        email: "test@example.com",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input_tokens: 123,
        output_tokens: 45,
        cache_creation_input_tokens: 6,
        cache_read_input_tokens: 7,
        cost_usd: 0.01234567,
        latency_ms: 890,
      }],
    });

    await flushUsageUploads();
    assert.equal(calls.length, 1, "nothing left to send after success");
  } finally {
    restore();
  }
});

test("UsageUploader skips upload when config is not eligible", async () => {
  const url = "http://127.0.0.1:9/skip";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status: 200 }));
  try {
    new UsageUploader({ ...CONFIG, name: null }, url).upload(record());
    new UsageUploader({ ...CONFIG, email: null }, url).upload(record());
    new UsageUploader({ ...CONFIG, uploadEnabled: false }, url).upload(record());
    await flushUsageUploads();
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("UsageUploader truncates identity fields to backend-safe limits", async () => {
  const url = "http://127.0.0.1:9/truncate";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status: 200 }));
  try {
    const uploader = new UsageUploader({
      name: "n".repeat(250),
      org: "o".repeat(250),
      email: `${"e".repeat(250)}@example.com`,
      uploadEnabled: true,
    }, url);
    uploader.upload(record());
    await uploader.flush();

    const [uploaded] = calls[0].body.records;
    assert.equal(uploaded.name.length, 200);
    assert.equal(uploaded.organization.length, 200);
    assert.equal(uploaded.email.length, 254);
  } finally {
    restore();
  }
});

test("many upload() calls across uploaders sharing a URL produce one request", async () => {
  const url = "http://127.0.0.1:9/merge";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status: 200 }));
  try {
    const first = new UsageUploader(CONFIG, url);
    const second = new UsageUploader({ ...CONFIG, name: "Other User" }, url);
    for (let i = 0; i < 5; i += 1) {
      (i % 2 ? second : first).upload(record(i));
    }
    await flushUsageUploads();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.records.map(r => r.input_tokens), [0, 1, 2, 3, 4]);
    assert.deepEqual(calls[0].body.records.map(r => r.name), ["Test User", "Other User", "Test User", "Other User", "Test User"]);
    assert.equal(calls[0].body.sdk_version, VERSION);
  } finally {
    restore();
  }
});

test("reaching 100 queued records flushes immediately in chunks of 100", async () => {
  const url = "http://127.0.0.1:9/size-trigger";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status: 200 }));
  try {
    const uploader = new UsageUploader(CONFIG, url);
    for (let i = 0; i < 99; i += 1) uploader.upload(record(i));
    assert.equal(calls.length, 0);
    uploader.upload(record(99));
    assert.equal(calls.length, 1, "100th record starts a flush right away");
    assert.equal(calls[0].body.records.length, 100);

    for (let i = 100; i < 250; i += 1) uploader.upload(record(i));
    await flushUsageUploads();

    assert.deepEqual(calls.map(c => c.body.records.length), [100, 100, 50]);
    assert.equal(new Set(calls.map(c => c.body.batch_id)).size, 3);
    assert.deepEqual(calls.flatMap(c => c.body.records.map(r => r.input_tokens)), Array.from({ length: 250 }, (_, i) => i));
  } finally {
    restore();
  }
});

test("5xx and 429 responses keep the batch and retry it with the same batch_id and records", async () => {
  const statuses = [503, 429, 200];
  const server = await startServer((req, res, n) => reply(res, statuses[n - 1] ?? 200));
  try {
    const uploader = new UsageUploader(CONFIG, server.baseUrl);
    uploader.upload(record(1));
    uploader.upload(record(2));
    uploader.upload(record(3));

    await flushUsageUploads();
    assert.equal(server.requests.length, 1);
    uploader.upload(record(4));
    await flushUsageUploads();
    assert.equal(server.requests.length, 2, "a failed retry stops the flush");
    await flushUsageUploads();
    assert.equal(server.requests.length, 4, "retried batch, then the newly queued record");
    await flushUsageUploads();
    assert.equal(server.requests.length, 4, "nothing left after success");

    const [first, second, third, fourth] = server.requests;
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.deepEqual(first.records.map(r => r.input_tokens), [1, 2, 3]);
    assert.deepEqual(fourth.records.map(r => r.input_tokens), [4]);
    assert.notEqual(fourth.batch_id, first.batch_id);
  } finally {
    await server.close();
  }
});

test("network errors keep the batch for retry with the same batch_id", async () => {
  const url = "http://127.0.0.1:9/network";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, (call, n) => {
    if (n === 1) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  });
  try {
    const uploader = new UsageUploader(CONFIG, url);
    uploader.upload(record(7));
    await uploader.flush();
    assert.equal(calls.length, 1);
    await uploader.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.body, calls[0].init.body);
    await uploader.flush();
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("4xx responses drop the batch", async () => {
  const server = await startServer((req, res, n) => reply(res, n === 1 ? 400 : 200, n === 1 ? { error: "bad" } : { accepted: 1 }));
  try {
    const uploader = new UsageUploader(CONFIG, server.baseUrl);
    uploader.upload(record(1));
    uploader.upload(record(2));
    await flushUsageUploads();
    await flushUsageUploads();
    assert.equal(server.requests.length, 1, "a rejected batch is not retried");

    uploader.upload(record(3));
    await flushUsageUploads();
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[1].records.map(r => r.input_tokens), [3]);
    assert.notEqual(server.requests[1].batch_id, server.requests[0].batch_id);
  } finally {
    await server.close();
  }
});

test("buffer is capped at 1000 records, dropping the oldest queued ones", async () => {
  const url = "http://127.0.0.1:9/cap";
  let status = 500;
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status }));
  try {
    const uploader = new UsageUploader(CONFIG, url);
    for (let i = 0; i < 1050; i += 1) uploader.upload(record(i));
    assert.equal(calls.length, 1, "failed batch suppresses further size-triggered flushes");

    status = 200;
    await flushUsageUploads();

    const delivered = calls.slice(1);
    assert.deepEqual(delivered[0].body, calls[0].body, "in-flight batch is retried verbatim");
    const ids = delivered.flatMap(c => c.body.records.map(r => r.input_tokens));
    assert.equal(ids.length, 1000);
    assert.deepEqual(ids, [...Array.from({ length: 100 }, (_, i) => i), ...Array.from({ length: 900 }, (_, i) => i + 150)]);
    assert.ok(delivered.every(c => c.body.records.length <= 100));
  } finally {
    restore();
  }
});

test("queued records are flushed by the 60 s timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const url = "http://127.0.0.1:9/timer";
  const { calls, restore } = stubFetch(`${url}/api/usage/upload`, () => new Response("{}", { status: 200 }));
  try {
    const uploader = new UsageUploader(CONFIG, url);
    uploader.upload(record(1));
    t.mock.timers.tick(59_999);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
    await uploader.flush();
  } finally {
    restore();
  }
});

test("short-lived processes deliver queued records on exit and are not kept alive by the timer", async () => {
  const server = await startServer((req, res) => reply(res, 200));
  try {
    const script = `
      const { UsageUploader } = await import(${JSON.stringify(DIST_INDEX)});
      const uploader = new UsageUploader(${JSON.stringify(CONFIG)}, process.env.UPLOAD_BASE);
      for (let i = 0; i < 3; i += 1) uploader.upload({ ts: new Date().toISOString(), provider: "p", model: "m", in: i });
    `;
    const result = await runChild(script, { UPLOAD_BASE: server.baseUrl });
    assert.equal(result.error, null, result.stderr);
    assert.ok(result.elapsed < 10_000, `child took ${result.elapsed} ms`);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0].records.map(r => r.input_tokens), [0, 1, 2]);
  } finally {
    await server.close();
  }
});

test("exit flush does not loop when the server keeps failing", async () => {
  const server = await startServer((req, res) => reply(res, 500, { error: "limit" }));
  try {
    const script = `
      const { UsageUploader } = await import(${JSON.stringify(DIST_INDEX)});
      new UsageUploader(${JSON.stringify(CONFIG)}, process.env.UPLOAD_BASE).upload({ ts: new Date().toISOString(), provider: "p", model: "m" });
    `;
    const result = await runChild(script, { UPLOAD_BASE: server.baseUrl });
    assert.equal(result.error, null, result.stderr);
    assert.ok(result.elapsed < 10_000, `child took ${result.elapsed} ms`);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("gateway SIGTERM flushes queued usage uploads before exiting", async () => {
  const server = await startServer((req, res) => reply(res, 200));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-upload-shutdown-"));
  try {
    const script = `
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => realFetch(String(input).replace("https://aistatus.cc", process.env.UPLOAD_BASE), init);
      const { configure } = await import(${JSON.stringify(DIST_INDEX)});
      const { GatewayServer } = await import(${JSON.stringify(DIST_GATEWAY)});
      configure(${JSON.stringify(CONFIG)});
      const gateway = new GatewayServer({ host: "127.0.0.1", port: 0, status_check: false, endpoints: {} });
      await gateway.run();
      gateway.usage.recordUsage({ provider: "p", model: "m", input_tokens: 5, output_tokens: 6, latency_ms: 1, fallback: false });
      process.kill(process.pid, "SIGTERM");
    `;
    const result = await runChild(script, { UPLOAD_BASE: server.baseUrl, HOME: home, USERPROFILE: home });
    assert.equal(result.error, null, result.stderr);
    assert.ok(result.elapsed < 5_000, `shutdown took ${result.elapsed} ms`);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].records[0].input_tokens, 5);
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("flushUsageUploads resolves within its timeout when the server hangs", async () => {
  const hanging = await startServer(() => {});
  try {
    new UsageUploader(CONFIG, hanging.baseUrl).upload(record(1));
    const started = performance.now();
    await flushUsageUploads(200);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `flush took ${elapsed} ms`);
    assert.equal(hanging.requests.length, 1);
  } finally {
    await hanging.close();
  }
});
