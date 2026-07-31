// input:  Gateway endpoint configuration and parsed provider usage
// output: shared Gateway backend and usage accounting types
// pos:    Internal Gateway server type contracts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

export interface Backend {
  id: string;
  base_url: string;
  api_key: string;
  auth_style: string;
  model_prefix: string;
  model_map: Record<string, string>;
  translate: string | null;
}

export interface GatewayUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}
