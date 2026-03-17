import { fetchJson, isRecord, readEnv, requireApiKey } from "../http";
import type {
  ChatMessage,
  ProviderCallOptions,
  RouteResponse as RouteResponseShape,
} from "../models";
import { RouteResponse } from "../models";
import { ProviderAdapter, registerAdapterType } from "./base";

interface GoogleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export class GoogleAdapter extends ProviderAdapter {
  private readonly defaultBaseUrl =
    "https://generativelanguage.googleapis.com/v1beta";
  private readonly defaultEnvVar = "GEMINI_API_KEY";

  async call(
    modelId: string,
    messages: ChatMessage[],
    timeoutSeconds: number,
    options: ProviderCallOptions,
  ): Promise<RouteResponseShape> {
    const providerOptions = { ...(options.providerOptions ?? {}) };
    const generationConfig = isRecord(providerOptions.generationConfig)
      ? { ...providerOptions.generationConfig }
      : {};
    const systemParts: string[] = [];
    const contents = messages
      .filter((message) => {
        if (message.role === "system") {
          systemParts.push(message.content);
          return false;
        }

        return true;
      })
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));

    if (
      options.maxTokens !== undefined &&
      generationConfig.maxOutputTokens === undefined
    ) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }

    if (
      options.temperature !== undefined &&
      generationConfig.temperature === undefined
    ) {
      generationConfig.temperature = options.temperature;
    }

    if (options.topP !== undefined && generationConfig.topP === undefined) {
      generationConfig.topP = options.topP;
    }

    const body: Record<string, unknown> = {
      ...providerOptions,
      contents,
    };

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    if (systemParts.length > 0 && body.systemInstruction === undefined) {
      body.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }

    const modelName = normalizeGoogleModelName(this.stripProvider(modelId));
    const apiKey = requireApiKey(
      this.slug,
      this.config.apiKey ?? readEnv(this.config.env ?? this.defaultEnvVar),
      this.config.env ?? this.defaultEnvVar,
    );
    const url = new URL(
      `${this.config.baseUrl ?? this.defaultBaseUrl}/models/${modelName}:generateContent`,
    );
    url.searchParams.set("key", apiKey);

    const response = await fetchJson<GoogleResponse>(url.toString(), {
      method: "POST",
      headers: {
        ...(this.config.headers ?? {}),
        ...(options.headers ?? {}),
      },
      body,
      timeoutMs: timeoutSeconds * 1_000,
      signal: options.signal,
    });

    return new RouteResponse({
      content: (response.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n"),
      modelUsed: modelId,
      providerUsed: this.slug,
      wasFallback: false,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      raw: response,
    });
  }
}

function normalizeGoogleModelName(modelName: string): string {
  return modelName.startsWith("models/") ? modelName.slice(7) : modelName;
}

registerAdapterType("google", GoogleAdapter);
