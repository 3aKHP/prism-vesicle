const encoder = new TextEncoder();

/**
 * Encode each chunk verbatim into a byte stream. The caller controls SSE
 * framing (event terminators, line breaks). Use when the input already
 * carries the wire format.
 */
export function bytesFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * Treat each block as one Server-Sent-Event and append the `\n\n` event
 * terminator. Use when the input blocks are event payloads without the
 * trailing blank line.
 */
export function sseFromBlocks(blocks: string[]): ReadableStream<Uint8Array> {
  return bytesFromChunks(blocks.map((block) => `${block}\n\n`));
}
