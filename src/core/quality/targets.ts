import type { EngineId } from "../engine/profile";
import { readWritableProjectText, type FileToolEvent, type ToolResult } from "../tools";
import type {
  DurableQualityArtifactTarget,
  QualityArtifactOperation,
  QualityArtifactReadResult,
  QualityArtifactTarget,
  QualityCandidateType,
} from "./types";

const artifactOperations = new Set<QualityArtifactOperation>(["create", "write", "replace", "append"]);
export const maxQualityArtifactBytes = 1024 * 1024;

export function qualityCandidateTypeForProducer(producer: string): QualityCandidateType | undefined {
  switch (producer) {
    case "runtime": return "runtime.prose";
    case "stage": return "stage.prose";
    case "dyad": return "dyad.character-response";
    case "weaver":
    case "scene-writer": return "scene.prose";
    case "weaver-orch": return "orchestrator-authored-prose";
    default: return undefined;
  }
}

export function qualityArtifactTargetFromResult(
  producer: EngineId | string,
  result: Pick<ToolResult, "callId" | "ok" | "fileEvent">,
): QualityArtifactTarget | undefined {
  const event = result.fileEvent;
  const candidateType = qualityCandidateTypeForProducer(producer);
  if (!result.ok || !candidateType || !isArtifactMutationEvent(event) || !targetAppliesToProducer(producer, event.path)) {
    return undefined;
  }
  return {
    id: `artifact:${event.path}`,
    kind: "artifact-post-image",
    candidateType,
    path: event.path,
    operation: event.operation,
    mutationCallIds: [result.callId],
    postImageHash: event.sha256,
    bytes: event.bytes,
    rejectedHashes: new Set<string>(),
  };
}

export function upsertQualityArtifactTarget(targets: QualityArtifactTarget[], next: QualityArtifactTarget): void {
  const index = targets.findIndex((target) => target.path === next.path);
  if (index < 0) {
    targets.push(next);
    return;
  }
  const previous = targets[index]!;
  targets[index] = {
    ...next,
    mutationCallIds: [...new Set([...previous.mutationCallIds, ...next.mutationCallIds])],
    rejectedHashes: previous.rejectedHashes,
  };
}

export function durableQualityTargets(targets: QualityArtifactTarget[]): DurableQualityArtifactTarget[] {
  return targets.map((target) => ({
    ...target,
    mutationCallIds: [...target.mutationCallIds],
    rejectedHashes: [...target.rejectedHashes],
  }));
}

export function hydrateQualityTargets(targets: DurableQualityArtifactTarget[] | undefined): QualityArtifactTarget[] {
  return (targets ?? []).map((target) => ({
    ...target,
    mutationCallIds: [...target.mutationCallIds],
    rejectedHashes: new Set(target.rejectedHashes),
  }));
}

export function upsertDurableQualityTarget(
  targets: DurableQualityArtifactTarget[],
  producer: EngineId | string,
  result: Pick<ToolResult, "callId" | "ok" | "fileEvent">,
): void {
  const next = qualityArtifactTargetFromResult(producer, result);
  if (!next) return;
  const hydrated = hydrateQualityTargets(targets);
  upsertQualityArtifactTarget(hydrated, next);
  targets.splice(0, targets.length, ...durableQualityTargets(hydrated));
}

export async function readQualityArtifactTargets(
  rootDir: string,
  targets: QualityArtifactTarget[],
): Promise<QualityArtifactReadResult[]> {
  return Promise.all(targets.map(async (target) => {
    try {
      const postImage = await readWritableProjectText(rootDir, target.path);
      target.path = postImage.path;
      target.id = `artifact:${postImage.path}`;
      target.postImageHash = postImage.sha256;
      target.bytes = postImage.bytes;
      return postImage.bytes > maxQualityArtifactBytes
        ? { target, warningReason: "target-oversize" }
        : { target, content: postImage.content };
    } catch {
      return { target, warningReason: "target-unreadable" };
    }
  }));
}

export function isQualityArtifactMutationCall(call: { name: string; arguments: string }, producer: string): boolean {
  if (!new Set(["create_file", "write_file", "replace_in_file", "append_file"]).has(call.name)) return false;
  if (producer === "weaver-orch") return false;
  if (producer !== "weaver" && producer !== "scene-writer") return true;
  try {
    const args = JSON.parse(call.arguments) as { path?: unknown };
    return typeof args.path === "string" && targetAppliesToProducer(producer, args.path.replaceAll("\\", "/"));
  } catch {
    return false;
  }
}

function isArtifactMutationEvent(event: FileToolEvent | undefined): event is FileToolEvent & {
  operation: QualityArtifactOperation;
  path: string;
  bytes: number;
  sha256: string;
} {
  return event?.kind === "file_operation"
    && event.changed
    && artifactOperations.has(event.operation as QualityArtifactOperation)
    && typeof event.path === "string"
    && typeof event.bytes === "number"
    && typeof event.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(event.sha256);
}

function targetAppliesToProducer(producer: string, path: string): boolean {
  if (producer === "weaver-orch") return false;
  if (producer !== "weaver" && producer !== "scene-writer") return true;
  return /(?:^|\/)Scene_[0-9]+\.md$/i.test(path);
}
