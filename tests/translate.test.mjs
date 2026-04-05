import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicRequestToOpenai,
  openaiResponseToAnthropic,
  openaiSseToAnthropicSse,
} from "../dist/gateway/index.js";

test("anthropicRequestToOpenai converts messages and system prompt", () => {
  const anthropicBody = {
    model: "claude-sonnet-4-6",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    max_tokens: 1024,
    temperature: 0.7,
  };

  const result = JSON.parse(
    anthropicRequestToOpenai(Buffer.from(JSON.stringify(anthropicBody))).toString()
  );

  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, "You are helpful.");
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[1].content, "Hello");
  assert.equal(result.max_tokens, 1024);
  assert.equal(result.temperature, 0.7);
});

test("anthropicRequestToOpenai handles structured system blocks", () => {
  const body = {
    model: "test",
    system: [
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ],
    messages: [{ role: "user", content: "Hi" }],
  };

  const result = JSON.parse(
    anthropicRequestToOpenai(Buffer.from(JSON.stringify(body))).toString()
  );

  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[0].content, "Line 1\nLine 2");
});

test("anthropicRequestToOpenai adds stream_options when stream:true", () => {
  const body = {
    model: "test",
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  };

  const result = JSON.parse(
    anthropicRequestToOpenai(Buffer.from(JSON.stringify(body))).toString()
  );

  assert.equal(result.stream, true);
  assert.deepEqual(result.stream_options, { include_usage: true });
});

test("openaiResponseToAnthropic converts response format", () => {
  const openaiResp = {
    id: "chatcmpl-123",
    choices: [
      {
        message: { content: "Hello world" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
    },
  };

  const result = JSON.parse(
    openaiResponseToAnthropic(
      Buffer.from(JSON.stringify(openaiResp)),
      "claude-sonnet-4-6"
    ).toString()
  );

  assert.equal(result.type, "message");
  assert.equal(result.role, "assistant");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.content[0].text, "Hello world");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 20);
  assert.ok(result.id.startsWith("msg_"));
});

test("openaiResponseToAnthropic maps finish_reason=length to max_tokens", () => {
  const openaiResp = {
    id: "x",
    choices: [{ message: { content: "..." }, finish_reason: "length" }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };

  const result = JSON.parse(
    openaiResponseToAnthropic(Buffer.from(JSON.stringify(openaiResp))).toString()
  );

  assert.equal(result.stop_reason, "max_tokens");
});

test("openaiSseToAnthropicSse emits terminal events only once when finish_reason and [DONE] both arrive", async () => {
  const events = [
    'data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ];

  async function* fakeChunks() {
    for (const ev of events) {
      yield Buffer.from(ev);
    }
  }

  const collected = [];
  for await (const chunk of openaiSseToAnthropicSse(fakeChunks(), "test-model")) {
    collected.push(chunk.toString());
  }

  const fullOutput = collected.join("");
  assert.equal(fullOutput.match(/event: content_block_stop/g)?.length ?? 0, 1);
  assert.equal(fullOutput.match(/event: message_delta/g)?.length ?? 0, 1);
  assert.equal(fullOutput.match(/event: message_stop/g)?.length ?? 0, 1);
});
