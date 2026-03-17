export class AIStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AllProvidersDown extends AIStatusError {
  readonly tried: string[];

  constructor(tried: string[]) {
    super(
      `All providers unavailable. Tried: ${tried.join(", ")}. Check https://aistatus.cc for current status.`,
    );
    this.tried = tried;
  }
}

export class ProviderCallFailed extends AIStatusError {
  readonly provider: string;
  readonly model: string;
  readonly cause: unknown;

  constructor(provider: string, model: string, cause: unknown) {
    super(`${provider} (${model}) call failed: ${String(cause)}`);
    this.provider = provider;
    this.model = model;
    this.cause = cause;
  }
}

export class NoBudgetMatch extends AIStatusError {
  readonly maxCost: number;
  readonly tier: string;

  constructor(maxCost: number, tier: string) {
    super(`No operational model in tier '${tier}' under $${maxCost}/M tokens.`);
    this.maxCost = maxCost;
    this.tier = tier;
  }
}

export class ProviderNotConfigured extends AIStatusError {
  readonly provider: string;
  readonly envName?: string;

  constructor(provider: string, envName?: string) {
    super(
      envName
        ? `Provider '${provider}' is not configured. Set ${envName} or pass apiKey explicitly.`
        : `Provider '${provider}' is not configured. Pass apiKey explicitly.`,
    );
    this.provider = provider;
    this.envName = envName;
  }
}

export class ProviderNotInstalled extends AIStatusError {
  readonly provider: string;
  readonly packageName?: string;

  constructor(provider: string, packageName?: string) {
    super(
      packageName
        ? `Provider '${provider}' requires package '${packageName}'.`
        : `Provider '${provider}' is not available in this runtime.`,
    );
    this.provider = provider;
    this.packageName = packageName;
  }
}

export class CheckAPIUnreachable extends AIStatusError {
  constructor() {
    super(
      "Could not reach aistatus.cc API. Proceeding with provider inference only.",
    );
  }
}
