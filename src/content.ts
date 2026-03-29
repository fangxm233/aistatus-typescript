import type { ContentBlock } from "./models";

/** Extract plain text from a content value (string or ContentBlock[]). */
export function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Normalize content to ContentBlock[] format. */
export function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content;
}
