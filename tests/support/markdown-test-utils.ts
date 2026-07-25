import type { testRender } from "@opentui/solid";

export function foregroundFor(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string,
): [number, number, number, number] {
  const span = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  if (!span) throw new Error(`Missing rendered span: ${text}`);
  return span.fg.toInts();
}
