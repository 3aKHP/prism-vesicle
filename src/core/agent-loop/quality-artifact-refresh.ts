import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";
import {
  durableQualityTargets,
  evaluateBoundQualityTargets,
  hydrateQualityTargets,
  qualityModeForEngine,
  readQualityArtifactTargets,
  recordQualityEvent,
  type QualityDecisionPoint,
  type QualityRuntimeContext,
  type QualityWarning,
} from "../quality";
import { createSessionStore, loadSessionSnapshot, type SessionSnapshot } from "../session/store";
import {
  assertQualityIdentity,
  matchesQualityIdentity,
  type QualityContinuationOptions,
} from "./quality-continuation-bootstrap";

export async function refreshQualityDecisionArtifacts(
  rootDir: string,
  sessionId: string,
  quality: QualityRuntimeContext,
): Promise<SessionSnapshot> {
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
  const point = snapshot.pendingQualityDecision;
  if (!point || point.request.reason !== "exhausted" || point.qualityState.targets.length === 0) return snapshot;
  assertQualityIdentity(quality, point.qualityState);
  const targets = hydrateQualityTargets(point.qualityState.targets);
  const reads = await readQualityArtifactTargets(rootDir, targets);
  const previous = new Map(snapshot.qualityWarnings
    .flatMap((warning) => warning.targets)
    .map((target) => [target.id, target]));
  const changed = reads.some(({ target, warningReason }) => {
    const prior = previous.get(target.id);
    return Boolean(prior)
      && (prior!.warningReason !== warningReason || prior!.candidateHash !== target.postImageHash);
  });
  if (!changed) return snapshot;

  const state = {
    attempts: Math.max(2, point.qualityState.attempts),
    rejectedHashes: new Set(point.qualityState.rejectedHashes),
    targets,
  };
  const result = evaluateBoundQualityTargets({
    runtime: quality,
    producer: point.request.producer,
    mode: qualityModeForEngine(quality, point.request.producer),
    targets: reads,
    attempt: state.attempts,
    state,
  });
  if (!result) return snapshot;
  const session = await createSessionStore(rootDir, sessionId);
  await recordQualityEvent(session, result);

  if (result.action === "ask-user") {
    await recordRefreshedBlockingDecision(session, snapshot, point, state, targets, result);
  } else if (result.outcome === "inconclusive") {
    await recordRefreshedInconclusiveDecision(session, snapshot, point, state.attempts, result);
  } else {
    await session.appendMany([
      {
        role: "system",
        content: "",
        metadata: {
          kind: "quality-resolution",
          qualityResolution: {
            warningId: point.warning.id,
            resolution: "revised-clean",
            targetIds: point.warning.targets.map((target) => target.id),
          },
        },
      },
      { role: "system", content: "", metadata: { kind: "quality-check-cleared", warningId: point.warning.id } },
    ]);
  }
  return loadSessionSnapshot(rootDir, sessionId, { synthesizeDanglingToolResults: false });
}

export async function resolveActiveQualityRuntime(
  options: QualityContinuationOptions,
  snapshot: SessionSnapshot,
): Promise<QualityRuntimeContext | undefined> {
  const pending = snapshot.pendingQualityDecision?.qualityState ?? snapshot.pendingQualityRewrite;
  if (!pending) return undefined;
  try {
    if (options.harness) {
      assertSessionHarnessIdentity(snapshot.harness, options.harness.identity);
      return matchesQualityIdentity(options.harness.quality, pending) ? options.harness.quality : undefined;
    }
    const project = requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(options.rootDir ?? process.cwd()));
    assertSessionHarnessIdentity(snapshot.harness, project.harness.identity);
    return matchesQualityIdentity(project.harness.quality, pending) ? project.harness.quality : undefined;
  } catch {
    return undefined;
  }
}

async function recordRefreshedBlockingDecision(
  session: Awaited<ReturnType<typeof createSessionStore>>,
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  state: { attempts: number; rejectedHashes: Set<string> },
  targets: ReturnType<typeof hydrateQualityTargets>,
  result: NonNullable<ReturnType<typeof evaluateBoundQualityTargets>>,
): Promise<void> {
  const cleanTargetIds = new Set(result.event.targets
    .filter((target) => target.status === "clean" || target.status === "findings")
    .map((target) => target.id));
  for (const existingWarning of snapshot.qualityWarnings) {
    if (existingWarning.id === point.warning.id) continue;
    const resolvedTargetIds = existingWarning.targets
      .filter((target) => cleanTargetIds.has(target.id))
      .map((target) => target.id);
    if (resolvedTargetIds.length === 0) continue;
    await session.append({
      role: "system",
      content: "",
      metadata: {
        kind: "quality-resolution",
        qualityResolution: {
          warningId: existingWarning.id,
          resolution: "revised-clean",
          targetIds: resolvedTargetIds,
        },
      },
    });
  }
  const warningTargets = result.event.targets.filter((target) =>
    target.status === "warning" && !target.warningReason
  );
  const warning: QualityWarning = {
    id: point.warning.id,
    guard: "anti-ai-flavor",
    reason: "exhausted",
    producer: point.request.producer,
    attempt: state.attempts,
    targets: warningTargets,
  };
  const refreshedPoint: QualityDecisionPoint = {
    ...point,
    request: {
      ...point.request,
      findingCount: warningTargets.reduce((count, target) => count + target.findingIds.length, 0),
      targets: warningTargets.map((target) => ({
        id: target.id,
        ...(target.path ? { path: target.path } : {}),
        findingIds: [...target.findingIds],
      })),
    },
    warning,
    qualityState: {
      ...point.qualityState,
      attempts: state.attempts,
      rejectedHashes: [...state.rejectedHashes],
      targets: durableQualityTargets(targets),
    },
  };
  await session.append({
    role: "system",
    content: "The guarded artifact changed outside the pending decision and was checked again. The current revision still has blocking findings.",
    metadata: { kind: "quality-warning", qualityWarning: warning, qualityDecision: refreshedPoint },
  });
}

async function recordRefreshedInconclusiveDecision(
  session: Awaited<ReturnType<typeof createSessionStore>>,
  snapshot: SessionSnapshot,
  point: QualityDecisionPoint,
  attempt: number,
  result: NonNullable<ReturnType<typeof evaluateBoundQualityTargets>>,
): Promise<void> {
  const unresolvedTargetIds = new Set(result.event.targets
    .filter((target) => target.status === "warning")
    .map((target) => target.id));
  const resolvedTargetIds = point.warning.targets
    .filter((target) => !unresolvedTargetIds.has(target.id))
    .map((target) => target.id);
  await session.appendMany([
    ...(resolvedTargetIds.length > 0 ? [{
      role: "system" as const,
      content: "",
      metadata: {
        kind: "quality-resolution",
        qualityResolution: {
          warningId: point.warning.id,
          resolution: "revised-clean",
          targetIds: resolvedTargetIds,
        },
      },
    }] : []),
    {
      role: "system",
      content: "",
      metadata: { kind: "quality-check-cleared", warningId: point.warning.id },
    },
  ]);
  let reusedPointWarning = false;
  for (const reason of ["target-unreadable", "target-oversize", "detector-budget-exhausted"] as const) {
    const existingTargetIds = new Set(snapshot.qualityWarnings
      .filter((warning) => warning.id !== point.warning.id && warning.reason === reason)
      .flatMap((warning) => warning.targets.map((target) => target.id)));
    const warningTargets = result.event.targets.filter((target) =>
      target.warningReason === reason && !existingTargetIds.has(target.id)
    );
    if (warningTargets.length === 0) continue;
    const warning: QualityWarning = {
      id: !reusedPointWarning ? point.warning.id : `quality-warning_${crypto.randomUUID()}`,
      guard: "anti-ai-flavor",
      reason,
      producer: point.request.producer,
      attempt,
      targets: warningTargets,
    };
    await session.append({
      role: "system",
      content: "The guarded artifact changed outside the pending decision, but its current revision could not be checked conclusively.",
      metadata: { kind: "quality-warning", qualityWarning: warning },
    });
    reusedPointWarning = true;
  }
}
