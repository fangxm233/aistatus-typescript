// input:  GatewayServer, stubbed OpenAI Responses API streams
// output: Codex/Responses usage accounting regressions
// pos:    Gateway OpenAI Responses API accounting tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import test, { after } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = process.env.HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-codex-home-"));
process.env.HOME = suiteHome;

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

function tempUsageDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aistatus-codex-usage-"));
}

async function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function codexConfig(port) {
  return {
    host: "127.0.0.1", port, status_check: false, mode: "openai-codex",
    endpoints: {
      "openai-codex": {
        name: "openai-codex", base_url: "https://chatgpt.com/backend-api", auth_style: "bearer",
        keys: [], passthrough: true, fallbacks: [], model_fallbacks: {},
      },
    },
  };
}

/**
 * A realistic Codex stream: `response.created` names the model, deltas carry no usage at all, and
 * only the terminal `response.completed` reports totals — nested under `response`, with the cached
 * prefix folded into `input_tokens`.
 */
function responsesSseBody(usage, { model = "gpt-5.6-sol" } = {}) {
  const events = [
    { type: "response.created", response: { id: "resp_1", model, usage: null } },
    { type: "response.output_text.delta", delta: "hi", item_id: "msg_1", output_index: 0 },
    { type: "response.completed", response: { id: "resp_1", model, status: "completed", usage } },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runCodexStream(tag, { requestBody, responseBody }) {
  const { GatewayServer } = await import(`../dist/gateway/index.js?${tag}=${Date.now()}`);
  const { UsageStorage, UsageTracker } = await import(`../dist/index.js?${tag}=${Date.now()}`);

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(responseBody);
  const port = await freePort();
  const server = new GatewayServer(codexConfig(port));
  server.usage = new UsageTracker(new UsageStorage(tempUsageDir(), `/${tag}`));
  const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));

  try {
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, method: "POST",
        path: "/m/openai-codex/project=demo,trigger=user/openai-codex/codex/responses",
        headers: { "content-type": "application/json", authorization: "Bearer sk-user-oauth" },
      }, (res) => {
        res.on("data", () => {});
        res.on("error", reject);
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end(requestBody);
    });
    return server.usage.storage.read("all");
  } finally {
    globalThis.fetch = savedFetch;
    httpServer.close();
  }
}

test("Gateway records usage from an OpenAI Responses stream and splits out cached input", async () => {
  const records = await runCodexStream("codex-usage", {
    requestBody: JSON.stringify({ model: "gpt-5.6-sol", input: [], stream: true }),
    responseBody: responsesSseBody({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 1050,
    }),
  });

  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.model, "gpt-5.6-sol");
  // `inferProvider` folds `openai-codex` down to the `openai` vendor, the same way it folds any
  // `<vendor>-<variant>` endpoint. The model name is what distinguishes Codex traffic, and the
  // vendor is what the pricing table is keyed on, so the fold is kept.
  assert.equal(record.provider, "openai");
  // `input_tokens` is a TOTAL that already contains the 800 cached tokens; recording it verbatim
  // would double-count them, so the uncached remainder is 200.
  assert.equal(record.in, 200);
  assert.equal(record.cache_read_in, 800);
  assert.equal(record.out, 50);
  assert.equal(record.billing_mode, "openai-codex");
  assert.equal(record.project, "demo");
  assert.equal(record.trigger, "user");
});

test("Gateway names the Codex model from the stream when the request body is unreadable", async () => {
  // PI zstd-compresses the Codex SSE request body, so `extractModel()` cannot parse it. Without a
  // model recovered from the stream the record would land as `openai-codex/unknown`.
  const records = await runCodexStream("codex-zstd", {
    requestBody: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x99, 0x00, 0x00]),
    responseBody: responsesSseBody({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 20 },
      output_tokens: 7,
    }, { model: "gpt-6-astra" }),
  });

  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.model, "gpt-6-astra");
  assert.equal(record.in, 100);
  assert.equal(record.cache_creation_in, 20);
  assert.equal(record.out, 7);
});

test("Gateway leaves Anthropic usage untouched", async () => {
  // Anthropic carries no `input_tokens_details`, so it must not be re-normalized: its
  // `input_tokens` already excludes the cached prefix and subtracting again would zero it out.
  const anthropic = await runCodexStream("codex-anthropic", {
    requestBody: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    responseBody:
      'data: {"type":"message_start","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"cache_read_input_tokens":400}}}\n\n'
      + 'data: {"type":"message_delta","usage":{"output_tokens":25}}\n\n'
      + "data: [DONE]\n\n",
  });

  assert.equal(anthropic.length, 1);
  assert.equal(anthropic[0].in, 10);
  assert.equal(anthropic[0].cache_read_in, 400);
  assert.equal(anthropic[0].out, 25);
});
