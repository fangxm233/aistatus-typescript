import type { StreamChunk } from "./models";

/** Convert a routeStream() AsyncGenerator to a Web ReadableStream<string>. */
export function streamToReadable(
  stream: AsyncGenerator<StreamChunk>,
): ReadableStream<string> {
  return new ReadableStream<string>({
    async pull(controller) {
      // Loop until we enqueue data, close, or error — skipping non-text chunks
      for (;;) {
        const { value, done } = await stream.next();
        if (done) {
          controller.close();
          return;
        }
        if (value.type === "text" && value.text) {
          controller.enqueue(value.text);
          return;
        }
        if (value.type === "error") {
          controller.error(value.error ?? new Error("Unknown streaming error"));
          return;
        }
        if (value.type === "done") {
          controller.close();
          return;
        }
        // usage and other chunks are skipped — loop to next chunk
      }
    },
    cancel() {
      stream.return(undefined);
    },
  });
}
