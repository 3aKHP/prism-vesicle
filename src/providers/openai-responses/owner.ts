import { createHash } from "node:crypto";

export function responsesEndpointFingerprint(baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}
