import assert from "node:assert/strict";
import test from "node:test";

// input: built UsageUploader from dist plus temporary fetch stubs and SDK config values
// output: regression tests for upload payload construction, config gating, and fire-and-forget fetch behavior
// pos: uploader tests protecting the SDK's async usage upload bridge and silent-failure semantics
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

test("UsageUploader builds upload payload and fires fetch without awaiting", async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;

  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return new Promise(() => {});
  };

  try {
    const { UsageUploader } = await import(`../dist/index.js?payload=${Date.now()}`);

    const uploader = new UsageUploader({
      name: "Test User",
      org: "Test Org",
      email: "test@example.com",
      uploadEnabled: true,
    });

    const record = {
      ts: "2026-04-03T12:34:56.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      in: 123,
      out: 45,
      cache_creation_in: 6,
      cache_read_in: 7,
      cost: 0.01234567,
      latency_ms: 890,
    };

    assert.equal(uploader.upload(record), undefined);
    assert.equal(calls.length, 1);

    const [call] = calls;
    assert.equal(call.input, "https://aistatus.cc/api/usage/upload");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Content-Type"], "application/json");

    const payload = JSON.parse(call.init.body);
    assert.deepEqual(payload, {
      records: [
        {
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
        },
      ],
      sdk_version: "0.0.4",
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("UsageUploader skips upload when config is not eligible", async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;

  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  try {
    const { UsageUploader } = await import(`../dist/index.js?skip=${Date.now()}`);
    const record = {
      ts: "2026-04-03T12:34:56.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };

    new UsageUploader({
      name: null,
      org: "Test Org",
      email: "test@example.com",
      uploadEnabled: true,
    }).upload(record);

    new UsageUploader({
      name: "Test User",
      org: "Test Org",
      email: null,
      uploadEnabled: true,
    }).upload(record);

    new UsageUploader({
      name: "Test User",
      org: "Test Org",
      email: "test@example.com",
      uploadEnabled: false,
    }).upload(record);

    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("UsageUploader truncates identity fields to backend-safe limits", async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;

  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  try {
    const { UsageUploader } = await import(`../dist/index.js?truncate=${Date.now()}`);

    const uploader = new UsageUploader({
      name: "n".repeat(250),
      org: "o".repeat(250),
      email: `${"e".repeat(250)}@example.com`,
      uploadEnabled: true,
    });

    uploader.upload({
      ts: "2026-04-03T12:34:56.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.records[0].name.length, 200);
    assert.equal(payload.records[0].organization.length, 200);
    assert.equal(payload.records[0].email.length, 254);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
