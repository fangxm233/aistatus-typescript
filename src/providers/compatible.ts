import { registerAdapterType } from "./base";
import { OpenAIAdapter } from "./openai";

export class DeepSeekAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.deepseek.com";
  protected defaultEnvVar = "DEEPSEEK_API_KEY";
}

export class MistralAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.mistral.ai/v1";
  protected defaultEnvVar = "MISTRAL_API_KEY";
}

export class XAIAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.x.ai/v1";
  protected defaultEnvVar = "XAI_API_KEY";
}

export class GroqAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.groq.com/openai/v1";
  protected defaultEnvVar = "GROQ_API_KEY";
}

export class TogetherAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.together.xyz/v1";
  protected defaultEnvVar = "TOGETHER_API_KEY";
}

export class MoonshotAdapter extends OpenAIAdapter {
  protected defaultBaseUrl = "https://api.moonshot.cn/v1";
  protected defaultEnvVar = "MOONSHOT_API_KEY";
}

export class QwenAdapter extends OpenAIAdapter {
  protected defaultBaseUrl =
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  protected defaultEnvVar = "DASHSCOPE_API_KEY";
}

registerAdapterType("deepseek", DeepSeekAdapter);
registerAdapterType("mistral", MistralAdapter);
registerAdapterType("xai", XAIAdapter);
registerAdapterType("groq", GroqAdapter);
registerAdapterType("together", TogetherAdapter);
registerAdapterType("moonshot", MoonshotAdapter);
registerAdapterType("qwen", QwenAdapter);
