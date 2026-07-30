import type { ProviderAdapter, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { ProviderAttemptCommitBarrier } from "../../providers/shared/attempt-commit";

export async function runChildProviderRound(
  provider: ProviderAdapter,
  request: VesicleRequest,
  onProgress: (text: string) => void,
): Promise<VesicleResponse> {
  const barrier = new ProviderAttemptCommitBarrier();
  if (!provider.stream) return barrier.commit(await provider.complete(request));
  for await (const event of provider.stream(request)) {
    if (event.type === "content_delta" && event.delta.trim()) onProgress("writing response");
    else if (event.type === "tool_call_delta" && event.name) onProgress(`preparing ${event.name}`);
    else if (event.type === "attempt_started") barrier.start(event.attempt);
    else if (event.type === "tool_call_candidate") barrier.addCandidate(event.attempt, event.toolCall);
    else if (event.type === "attempt_discarded") barrier.discard(event.attempt);
    else if (event.type === "complete") return barrier.commit(event.response, event.attempt);
  }
  throw new Error("SubAgent provider stream ended without a final response.");
}
