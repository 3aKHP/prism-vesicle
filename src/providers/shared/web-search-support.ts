import type { ResponsesProfile, VesicleProvider } from "../../config/env";

const searchAdmittingResponsesProfiles = new Set<ResponsesProfile>([
  "openai-public",
  "deepseek-subset-2026-08-19",
]);

export function responsesProfileAdmitsBuiltInWebSearch(profile: ResponsesProfile | undefined): boolean {
  return profile !== undefined && searchAdmittingResponsesProfiles.has(profile);
}

export function providerAdmitsBuiltInWebSearch(config: {
  provider?: VesicleProvider;
  responsesProfile?: ResponsesProfile;
}): boolean {
  return config.provider === "gemini-generate-content"
    || (config.provider === "openai-responses"
      && responsesProfileAdmitsBuiltInWebSearch(config.responsesProfile));
}
