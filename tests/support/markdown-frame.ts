import type { testRender } from "@3akhp/opentui-solid";

/**
 * Poll the rendered frame until the expected state is visible. The markdown
 * renderable highlights asynchronously through the tree-sitter worker, and
 * its first frames draw the raw content — so the settled predicate must key
 * on a post-highlight state (for example the absence of an already-concealed
 * delimiter), never on text that is already present before the highlight
 * lands.
 */
export async function captureFrameUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  isSettled: (frame: string) => boolean,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (isSettled(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return setup.captureCharFrame();
}

export function captureFrameWhen(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string,
): Promise<string> {
  return captureFrameUntil(setup, (frame) => frame.includes(needle));
}
