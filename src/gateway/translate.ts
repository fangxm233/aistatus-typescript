/**
 * Translate between Anthropic Messages API and OpenAI Chat Completions API.
 *
 * Covers the common text-completion case (messages, system prompt, streaming).
 * Tool use and multimodal content are NOT translated — they pass through as-is.
 */

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

export function anthropicRequestToOpenai(body: Buffer): Buffer {
  const data = JSON.parse(body.toString("utf-8"));

  const messages: Array<{ role: string; content: string }> = [];

  // Anthropic "system" → OpenAI system message
  const system = data.system;
  if (system) {
    if (typeof system === "string") {
      messages.push({ role: "system", content: system });
    } else if (Array.isArray(system)) {
      const text = system
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => (b.text as string) ?? "")
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  // Messages
  for (const msg of data.messages ?? []) {
    const role = msg.role ?? "user";
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role, content });
    } else if (Array.isArray(content)) {
      const texts = content
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => (b.text as string) ?? "");
      if (texts.length > 0) {
        messages.push({ role, content: texts.join("\n") });
      }
    }
  }

  const openaiBody: Record<string, unknown> = {
    model: data.model ?? "",
    messages,
  };

  // Copy compatible params
  for (const key of ["max_tokens", "temperature", "top_p", "stream"]) {
    if (key in data) openaiBody[key] = data[key];
  }
  if ("stop_sequences" in data) {
    openaiBody.stop = data.stop_sequences;
  }
  // stream_options for OpenAI to include usage in streaming
  if (data.stream) {
    openaiBody.stream_options = { include_usage: true };
  }

  return Buffer.from(JSON.stringify(openaiBody), "utf-8");
}

// ---------------------------------------------------------------------------
// Response translation: OpenAI → Anthropic
// ---------------------------------------------------------------------------

export function openaiResponseToAnthropic(body: Buffer, originalModel = ""): Buffer {
  const data = JSON.parse(body.toString("utf-8"));

  let contentText = "";
  let stopReason = "end_turn";

  const choices = data.choices ?? [];
  if (choices.length > 0) {
    const choice = choices[0];
    contentText = choice.message?.content ?? "";
    const finish = choice.finish_reason ?? "stop";
    stopReason = { stop: "end_turn", length: "max_tokens" }[finish as string] ?? "end_turn";
  }

  const usage = data.usage ?? {};

  const anthropicResp = {
    id: `msg_${data.id ?? "gw"}`,
    type: "message",
    role: "assistant",
    model: originalModel || data.model || "",
    content: [{ type: "text", text: contentText }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };

  return Buffer.from(JSON.stringify(anthropicResp), "utf-8");
}

// ---------------------------------------------------------------------------
// Streaming translation: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: Record<string, unknown>): Buffer {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf-8");
}

/**
 * Transform a stream of raw OpenAI SSE chunks into Anthropic SSE events.
 * `chunks` is an async iterable of Buffer chunks from the upstream response.
 */
export async function* openaiSseToAnthropicSse(
  chunks: AsyncIterable<Buffer>,
  originalModel = "",
): AsyncGenerator<Buffer> {
  const msgId = `msg_gw_${Math.floor(Date.now() / 1000)}`;

  // Emit: message_start
  yield sseEvent("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: originalModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // Emit: content_block_start
  yield sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  let outputTokens = 0;
  let buffer = "";

  for await (const rawChunk of chunks) {
    buffer += rawChunk.toString("utf-8");

    // Split on SSE event boundaries
    while (buffer.includes("\n\n")) {
      const idx = buffer.indexOf("\n\n");
      const eventStr = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);

      if (!eventStr) continue;

      // Extract the data line(s)
      for (const line of eventStr.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();

        if (payload === "[DONE]") {
          yield sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          });
          yield sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          yield sseEvent("message_stop", { type: "message_stop" });
          return;
        }

        let oai: Record<string, unknown>;
        try {
          oai = JSON.parse(payload);
        } catch {
          continue;
        }

        // Usage info
        if (oai.usage && typeof oai.usage === "object") {
          const u = oai.usage as Record<string, number>;
          if (u.completion_tokens != null) outputTokens = u.completion_tokens;
        }

        const choices = (oai.choices as Array<Record<string, unknown>>) ?? [];
        if (choices.length === 0) continue;

        const delta = (choices[0].delta as Record<string, unknown>) ?? {};
        const text = delta.content;
        if (typeof text === "string" && text) {
          yield sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          });
        }

        // Check finish_reason
        if (choices[0].finish_reason) {
          yield sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          });
          yield sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          yield sseEvent("message_stop", { type: "message_stop" });
          return;
        }
      }
    }
  }
}
