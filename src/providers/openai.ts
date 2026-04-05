import { extractText, fetchJson, joinUrl, readEnv, requireApiKey } from "../http";
import type {
  ChatMessage,
  ContentBlock,
  ProviderCallOptions,
  RouteResponse as RouteResponseShape,
} from "../models";
import { RouteResponse } from "../models";
import { ProviderAdapter, registerAdapterType } from "./base";

interface OpenAIClient {
  chatCompletions(
    payload: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<OpenAIResponse>;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAIAdapter extends ProviderAdapter {
  protected defaultBaseUrl = "https://api.openai.com/v1";
  protected defaultEnvVar = "OPENAI_API_KEY";
  private _client: OpenAIClient | null = null;
  private _clientKey = "";

  protected getBaseUrl(): string {
    return this.config.baseUrl ?? this.defaultBaseUrl;
  }

  protected getApiKey(): string {
    return requireApiKey(
      this.slug,
      this.config.apiKey ?? readEnv(this.config.env ?? this.defaultEnvVar),
      this.config.env ?? this.defaultEnvVar,
    );
  }

  protected getDefaultHeaders(): Record<string, string> {
    return {};
  }

  protected buildPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ProviderCallOptions,
  ): Record<string, unknown> {
    const openaiMessages = messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === "string"
        ? msg.content
        : contentBlocksToOpenAI(msg.content),
      ...(msg.name ? { name: msg.name } : {}),
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    }));

    const payload: Record<string, unknown> = {
      ...(options.providerOptions ?? {}),
      model: this.stripProvider(modelId),
      messages: openaiMessages,
    };

    if (
      options.maxTokens !== undefined &&
      payload.max_tokens === undefined &&
      payload.max_completion_tokens === undefined
    ) {
      payload.max_tokens = options.maxTokens;
    }

    if (options.temperature !== undefined && payload.temperature === undefined) {
      payload.temperature = options.temperature;
    }

    if (options.topP !== undefined && payload.top_p === undefined) {
      payload.top_p = options.topP;
    }

    if (options.responseFormat && payload.response_format === undefined) {
      payload.response_format = options.responseFormat;
    }

    return payload;
  }

  async call(
    modelId: string,
    messages: ChatMessage[],
    timeoutSeconds: number,
    options: ProviderCallOptions,
  ): Promise<RouteResponseShape> {
    const apiKey = this.getApiKey();
    const client = this.getClient(apiKey);
    const response = await client.chatCompletions(
      this.buildPayload(modelId, messages, options),
      {
        timeoutMs: timeoutSeconds * 1_000,
        signal: options.signal,
        headers: {
          ...this.getDefaultHeaders(),
          ...(this.config.headers ?? {}),
          ...(options.headers ?? {}),
        },
      },
    );

    return this.toResponse(response, modelId);
  }

  protected getClient(apiKey = this.getApiKey()): OpenAIClient {
    const cacheKey = `${this.getBaseUrl()}::${apiKey}`;
    if (this._client && this._clientKey === cacheKey) {
      return this._client;
    }

    this._clientKey = cacheKey;
    this._client = {
      chatCompletions: (payload, options) =>
        fetchJson<OpenAIResponse>(joinUrl(this.getBaseUrl(), "chat/completions"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...(options.headers ?? {}),
          },
          body: payload,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        }),
    };
    return this._client;
  }

  protected toResponse(
    response: OpenAIResponse,
    modelId: string,
  ): RouteResponseShape {
    return new RouteResponse({
      content: extractText(response.choices?.[0]?.message?.content),
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      raw: response,
    });
  }
}

function contentBlocksToOpenAI(blocks: ContentBlock[]): unknown[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image_url":
        return { type: "image_url", image_url: block.image_url };
      case "image":
        // Convert Anthropic-style base64 to OpenAI data URI
        return {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        };
      default:
        return block;
    }
  });
}

registerAdapterType("openai", OpenAIAdapter);
