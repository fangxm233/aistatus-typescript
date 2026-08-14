// input:  built GatewayServer and synthetic HTTP messages
// output: Gateway request-body limit regression tests
// pos:    Request body size boundary test suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const endpoint = {
  name: "openai",
  base_url: "https://api.openai.com",
  auth_style: "openai",
  keys: [],
  passthrough: true,
  fallbacks: [],
  model_fallbacks: {},
};

function bodyLimitConfig(maxBodySizeMb) {
  const endpoints = { openai: endpoint };
  return {
    host: "127.0.0.1",
    port: 0,
    status_check: false,
    mode: "default",
    endpoints,
    endpoint_modes: { default: endpoints },
    ...(maxBodySizeMb === undefined ? {} : { max_body_size_mb: maxBodySizeMb }),
  };
}

function incomingRequest(body) {
  const req = new EventEmitter();
  req.url = "/openai/v1/chat/completions";
  req.method = "POST";
  req.headers = {};
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", body);
    req.emit("end");
  });
  return req;
}

function serverResponse() {
  return {
    headersSent: false,
    statusCode: undefined,
    writeHead(statusCode) {
      this.headersSent = true;
      this.statusCode = statusCode;
    },
    end() {},
  };
}

test("GatewayServer accepts an 11 MiB body with the 100 MiB default", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const server = new GatewayServer(bodyLimitConfig());
  const response = serverResponse();

  await server._handleRequest(incomingRequest(Buffer.alloc(11 * 1024 * 1024)), response);

  assert.equal(response.statusCode, 503);
});

test("GatewayServer applies configured max_body_size_mb", async () => {
  const { GatewayServer } = await import("../dist/gateway/index.js");
  const server = new GatewayServer(bodyLimitConfig(0.001));

  await assert.rejects(
    server._handleRequest(incomingRequest(Buffer.alloc(2048)), serverResponse()),
    /Request body too large/,
  );
});
