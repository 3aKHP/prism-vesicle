import type { ResponsesProfile } from "../../config/env";

/**
 * Incremental capability bits for Responses profiles (#225 slice 2).
 *
 * Profiles are dated compatibility contracts; a new capability never mutates a
 * frozen profile id. `deepseek-subset-2026-08-19` copies every constraint of
 * `deepseek-subset-2026-07-31` and additionally admits the built-in web search
 * tool, its call Items, and its SSE event family.
 */
export type ResponsesProfileCapabilities = {
  /** Profile admits `{type:"web_search"}` declarations and web_search_call Items/events. */
  webSearch: boolean;
};

const profileCapabilities: Record<ResponsesProfile, ResponsesProfileCapabilities> = {
  "openai-public": { webSearch: true },
  "codex-http-relay": { webSearch: false },
  "codex-beta-2026-02-06": { webSearch: false },
  "mimo-subset-2026-07-30": { webSearch: false },
  "deepseek-subset-2026-07-31": { webSearch: false },
  "deepseek-subset-2026-08-19": { webSearch: true },
};

export function responsesProfileCapabilities(profile: ResponsesProfile | undefined): ResponsesProfileCapabilities {
  return profile ? profileCapabilities[profile] : { webSearch: false };
}

export function supportsResponsesWebSearch(profile: ResponsesProfile | undefined): boolean {
  return responsesProfileCapabilities(profile).webSearch;
}

/** Stateful request fields (store, service_tier, encrypted reasoning) are omitted on subset profiles. */
export function isStatelessHttpSubset(profile: ResponsesProfile | undefined): boolean {
  return profile === "mimo-subset-2026-07-30" || isDeepSeekSubsetProfile(profile);
}

/** Subset profiles exchange plaintext reasoning via response.reasoning_text.* instead of summaries. */
export function isReasoningTextProfile(profile: ResponsesProfile | undefined): boolean {
  return profile === "mimo-subset-2026-07-30" || isDeepSeekSubsetProfile(profile);
}

export function isDeepSeekSubsetProfile(profile: ResponsesProfile | undefined): profile is "deepseek-subset-2026-07-31" | "deepseek-subset-2026-08-19" {
  return profile === "deepseek-subset-2026-07-31" || profile === "deepseek-subset-2026-08-19";
}

/**
 * DeepSeek's search mode attaches an opaque encrypted_content token to
 * reasoning Items that still carry plaintext reasoning_text (observed on the
 * official endpoint, 2026-08-20). Only the search-admitting dated subset
 * tolerates the extra field; mimo and the frozen 2026-07-31 subset stay
 * fail-closed against it.
 */
export function admitsEncryptedReasoningToken(profile: ResponsesProfile | undefined): boolean {
  return profile === "deepseek-subset-2026-08-19";
}
