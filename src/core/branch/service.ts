// Candidate-tree service for the /branch panel.
//
// Decorates the pure candidate tree from selection.ts with per-leaf file-state
// status so the panel can show which branches carry a restorable manifest and
// which would switch conversation-only. Read-only: switching is owned by the
// turn controller (switchToCandidate), regeneration by the agent loop.

import { findCandidatePostState, isCandidateFileDegraded } from "../checkpoints/candidate-files";
import { buildCandidateTree, type CandidateTreeBranch, type CandidateTreeFork } from "../session/selection";
import { loadSessionRecords, type SessionRecord } from "../session/store";

export type BranchBundleStatus = "bundled" | "missing" | "degraded";

export type BranchTreeCandidate = {
  rootUuid: string;
  endpointUuid: string;
  excerpt: string;
  ts: string;
  activePath: boolean;
  /** Authored turns inside this branch, including the branch's own prompt. */
  authoredTurnCount: number;
  bundleStatus: BranchBundleStatus;
  tainted: boolean;
  fork?: BranchTreeFork;
};

export type BranchTreeFork = {
  forkRecordUuid: string;
  promptExcerpt: string;
  activePath: boolean;
  candidates: BranchTreeCandidate[];
};

/**
 * The session's full candidate tree with per-leaf file-state status. Forks
 * appear at every depth, including inside inactive branches, so the panel can
 * reach any stored candidate.
 */
export async function listBranchTree(rootDir: string, sessionId: string): Promise<BranchTreeFork[]> {
  const records = await loadSessionRecords(rootDir, sessionId);
  return buildCandidateTree(records).map((fork) => decorateFork(fork, records));
}

function decorateFork(fork: CandidateTreeFork, records: SessionRecord[]): BranchTreeFork {
  return {
    forkRecordUuid: fork.forkRecordUuid,
    promptExcerpt: fork.forkExcerpt,
    activePath: fork.activePath,
    candidates: fork.candidates.map((branch) => decorateBranch(branch, records)),
  };
}

function decorateBranch(branch: CandidateTreeBranch, records: SessionRecord[]): BranchTreeCandidate {
  const degraded = isCandidateFileDegraded(records, branch.endpointUuid);
  const bundle = degraded ? undefined : findCandidatePostState(records, branch.endpointUuid);
  const bundleStatus: BranchBundleStatus = degraded ? "degraded" : bundle ? "bundled" : "missing";
  return {
    rootUuid: branch.rootUuid,
    endpointUuid: branch.endpointUuid,
    excerpt: branch.excerpt,
    ts: branch.ts,
    activePath: branch.activePath,
    authoredTurnCount: branch.authoredTurnCount,
    bundleStatus,
    tainted: bundle?.taintedByHostProcess === true,
    ...(branch.fork ? { fork: decorateFork(branch.fork, records) } : {}),
  };
}
