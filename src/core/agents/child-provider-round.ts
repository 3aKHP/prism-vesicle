import type { ProviderAdapter, VesicleRequest, VesicleResponse } from "../../providers/shared/types";

export async function runChildProviderRound(
  provider: ProviderAdapter,
  request: VesicleRequest,
  onProgress: (text: string) => void,
): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "content_delta" && event.delta.trim()) onProgress("writing response");
    else if (event.type === "tool_call_delta" && event.name) onProgress(`preparing ${event.name}`);
    else if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("SubAgent provider stream ended without a final response.");
  return response;
}
