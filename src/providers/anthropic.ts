import { extractTextFromContent } from "../content";
import { fetchJson, joinUrl, readEnv, requireApiKey } from "../http";
import type {
  ChatMessage,
  ContentBlock,
  ProviderCallOptions,
  RouteResponse as RouteResponseShape,
} from "../models";
import { RouteResponse } from "../models";
import { ProviderAdapter, registerAdapterType } from "./base";

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class AnthropicAdapter extends ProviderAdapter {
  private readonly defaultBaseUrl = "https://api.anthropic.com/v1";
  private readonly defaultEnvVar = "ANTHROPIC_API_KEY";

  async call(
    modelId: string,
    messages: ChatMessage[],
    timeoutSeconds: number,
    options: ProviderCallOptions,
  ): Promise<RouteResponseShape> {
    const systemParts: string[] = [];
    const anthropicMessages = messages
      .filter((message) => {
        if (message.role === "system") {
          systemParts.push(extractTextFromContent(message.content));
          return false;
        }

        return true;
      })
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string"
          ? message.content
          : contentBlocksToAnthropic(message.content),
      }));

    const payload: Record<string, unknown> = {
      ...(options.providerOptions ?? {}),
      model: this.stripProvider(modelId),
      messages: anthropicMessages,
    };

    if (systemParts.length > 0 && payload.system === undefined) {
      const systemText = systemParts.join("\n\n");
      const rfSuffix = responseFormatSuffix(options);
      payload.system = rfSuffix ? `${systemText}\n\n${rfSuffix}` : systemText;
    } else if (options.responseFormat && options.responseFormat.type !== "text") {
      const rfSuffix = responseFormatSuffix(options);
      if (rfSuffix) {
        payload.system = rfSuffix;
      }
    }

    if (payload.max_tokens === undefined) {
      payload.max_tokens = options.maxTokens ?? 4096;
    }

    if (options.temperature !== undefined && payload.temperature === undefined) {
      payload.temperature = options.temperature;
    }

    if (options.topP !== undefined && payload.top_p === undefined) {
      payload.top_p = options.topP;
    }

    const response = await fetchJson<AnthropicResponse>(
      joinUrl(this.config.baseUrl ?? this.defaultBaseUrl, "messages"),
      {
        method: "POST",
        headers: {
          "x-api-key": requireApiKey(
            this.slug,
            this.config.apiKey ?? readEnv(this.config.env ?? this.defaultEnvVar),
            this.config.env ?? this.defaultEnvVar,
          ),
          "anthropic-version": "2023-06-01",
          ...(this.config.headers ?? {}),
          ...(options.headers ?? {}),
        },
        body: payload,
        timeoutMs: timeoutSeconds * 1_000,
        signal: options.signal,
      },
    );

    return new RouteResponse({
      content: (response.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n"),
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      raw: response,
    });
  }
}

function contentBlocksToAnthropic(blocks: ContentBlock[]): unknown[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image_url":
        return {
          type: "image",
          source: { type: "url", url: block.image_url.url },
        };
      case "image":
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.source.media_type,
            data: block.source.data,
          },
        };
      default:
        return block;
    }
  });
}

function responseFormatSuffix(options: ProviderCallOptions): string | null {
  const rf = options.responseFormat;
  if (!rf || rf.type === "text") return null;
  if (rf.type === "json_object") return "Respond with valid JSON only.";
  if (rf.type === "json_schema") {
    return `Respond with valid JSON matching this schema:\n${JSON.stringify(rf.json_schema.schema, null, 2)}`;
  }
  return null;
}

registerAdapterType("anthropic", AnthropicAdapter);
