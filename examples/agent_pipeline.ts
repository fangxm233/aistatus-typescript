import { route } from "aistatus";

async function researchAgent(topic: string): Promise<string> {
  const plan = await route(topic, {
    model: "claude-haiku-4-5",
    system: "Break the topic into 3 research sub-questions. Be concise.",
  });
  console.log(`[Plan] via ${plan.modelUsed} fallback=${plan.wasFallback}`);

  const findings: string[] = [];

  for (const [index, question] of plan.content.trim().split("\n").slice(0, 3).entries()) {
    const answer = await route(question, {
      model: "claude-sonnet-4-6",
      system: "Answer this research question in 2-3 sentences.",
      prefer: ["anthropic", "google"],
    });
    console.log(`[Research ${index + 1}] via ${answer.modelUsed}`);
    findings.push(answer.content);
  }

  const synthesis = await route(findings.join("\n\n"), {
    model: "claude-opus-4-6",
    system: "Synthesize these research findings into a clear summary.",
  });
  console.log(`[Synthesis] via ${synthesis.modelUsed}`);

  return synthesis.content;
}

async function main(): Promise<void> {
  const result = await researchAgent(
    "How is embodied AI changing manufacturing?",
  );
  console.log("\n============================================================");
  console.log(result);
}

void main();
