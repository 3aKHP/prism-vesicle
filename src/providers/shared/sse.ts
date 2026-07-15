export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseSseBlock(part);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve original stream errors if the reader lock was already released.
    }
  }
}

function parseSseBlock(block: string): { event: string; data: string } | undefined {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("event:")) event = trimmed.slice("event:".length).trimStart();
    if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}
