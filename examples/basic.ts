import { route } from "aistatus";

async function main(): Promise<void> {
  const response = await route(
    "Summarize the latest deployment status.",
    {
      model: "claude-sonnet-4-6",
    },
  );

  console.log(response.content);
  console.log(response.modelUsed);
  console.log(response.providerUsed);
  console.log(response.wasFallback);
  console.log(response.fallbackReason);
}

void main();
