export interface AutoProviderSpec {
  envVar: string;
  adapterType: string;
  aliases?: string[];
}

export const AUTO_PROVIDERS: Record<string, AutoProviderSpec> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    adapterType: "anthropic",
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    adapterType: "openai",
  },
  google: {
    envVar: "GEMINI_API_KEY",
    adapterType: "google",
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    adapterType: "openrouter",
  },
  deepseek: {
    envVar: "DEEPSEEK_API_KEY",
    adapterType: "deepseek",
  },
  mistral: {
    envVar: "MISTRAL_API_KEY",
    adapterType: "mistral",
    aliases: ["mistralai"],
  },
  xai: {
    envVar: "XAI_API_KEY",
    adapterType: "xai",
    aliases: ["x-ai"],
  },
  groq: {
    envVar: "GROQ_API_KEY",
    adapterType: "groq",
  },
  together: {
    envVar: "TOGETHER_API_KEY",
    adapterType: "together",
  },
  moonshot: {
    envVar: "MOONSHOT_API_KEY",
    adapterType: "moonshot",
    aliases: ["moonshotai"],
  },
  qwen: {
    envVar: "DASHSCOPE_API_KEY",
    adapterType: "qwen",
  },
};

export const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  openrouter: "openrouter",
  deepseek: "deepseek",
  mistral: "mistral",
  mistralai: "mistral",
  xai: "xai",
  "x-ai": "xai",
  groq: "groq",
  together: "together",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  qwen: "qwen",
};

export const MODEL_PREFIX_MAP: Record<string, string> = {
  claude: "anthropic",
  gpt: "openai",
  o1: "openai",
  o3: "openai",
  o4: "openai",
  chatgpt: "openai",
  gemini: "google",
  deepseek: "deepseek",
  mistral: "mistral",
  codestral: "mistral",
  pixtral: "mistral",
  grok: "xai",
  llama: "groq",
  qwen: "qwen",
  moonshot: "moonshot",
};

export function normalizeProviderSlug(slug: string | null | undefined): string {
  const value = (slug ?? "").trim().toLowerCase();
  return PROVIDER_ALIASES[value] ?? value;
}

export function extractProviderSlug(
  modelId: string | null | undefined,
): string | null {
  const value = (modelId ?? "").trim();
  if (!value.includes("/")) {
    return null;
  }

  return normalizeProviderSlug(value.split("/", 1)[0]);
}
