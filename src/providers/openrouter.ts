import { OpenAIAdapter } from "./openai";
import { registerAdapterType } from "./base";

export class OpenRouterAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://openrouter.ai/api/v1";
  protected defaultEnvVar = "OPENROUTER_API_KEY";

  protected getDefaultHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://aistatus.cc",
      "X-Title": "aistatus",
    };
  }
}

registerAdapterType("openrouter", OpenRouterAdapter);
