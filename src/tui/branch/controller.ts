import { createSignal } from "solid-js";
import { listBranchTree, type BranchTreeCandidate, type BranchTreeFork } from "../../core/branch/service";
import { candidateSwitchPreview } from "../../core/checkpoints/candidate-files";
import type { FileCheckpointDiffStats } from "../../core/checkpoints/file-history";
import { normalizeKeyName } from "../composer";

export type BranchKeyEvent = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  sequence?: string;
};

export type BranchRow =
  | { kind: "fork"; key: string; depth: number; fork: BranchTreeFork }
  | { kind: "candidate"; key: string; depth: number; candidate: BranchTreeCandidate };

export type BranchPickerConfirm = {
  kind: "switch" | "regenerate";
  fork: BranchTreeFork;
  candidate?: BranchTreeCandidate;
  selected: number;
  diffStats?: FileCheckpointDiffStats;
};

export type BranchPickerState = {
  forks: BranchTreeFork[];
  selected: number;
  /** Expanded fork keys (forkRecordUuid) and candidate keys (rootUuid). */
  expanded: string[];
  confirm?: BranchPickerConfirm;
  busy: boolean;
  error?: string;
};

/** Flatten the tree into display rows: fork rows carry their candidates when
 * expanded, and an expanded candidate reveals its nested fork. */
export function flattenBranchRows(forks: BranchTreeFork[], expanded: string[]): BranchRow[] {
  const expandedSet = new Set(expanded);
  const rows: BranchRow[] = [];
  const walkFork = (fork: BranchTreeFork, depth: number) => {
    rows.push({ kind: "fork", key: fork.forkRecordUuid, depth, fork });
    if (!expandedSet.has(fork.forkRecordUuid)) return;
    for (const candidate of fork.candidates) {
      rows.push({ kind: "candidate", key: candidate.rootUuid, depth: depth + 1, candidate });
      if (candidate.fork && expandedSet.has(candidate.rootUuid)) walkFork(candidate.fork, depth + 2);
    }
  };
  for (const fork of forks) walkFork(fork, 0);
  return rows;
}

/** Expansion keys along the active path: every active fork, plus the active
 * candidate whose nested fork continues the path. */
export function activePathExpansionKeys(forks: BranchTreeFork[]): string[] {
  const keys: string[] = [];
  const walk = (fork: BranchTreeFork) => {
    if (!fork.activePath) return;
    keys.push(fork.forkRecordUuid);
    const active = fork.candidates.find((candidate) => candidate.activePath);
    if (active?.fork) {
      keys.push(active.rootUuid);
      walk(active.fork);
    }
  };
  for (const fork of forks) walk(fork);
  return keys;
}

export function branchConfirmOptions(confirm: BranchPickerConfirm): Array<{ value: "go" | "nevermind"; label: string }> {
  if (confirm.kind === "regenerate") {
    return [
      { value: "go", label: "Regenerate this turn" },
      { value: "nevermind", label: "Never mind" },
    ];
  }
  return [
    confirm.candidate?.bundleStatus === "bundled"
      ? { value: "go", label: "Switch candidate (conversation + files)" }
      : { value: "go", label: "Switch conversation only (no saved file state)" },
    { value: "nevermind", label: "Never mind" },
  ];
}

export type BranchControllerDependencies = {
  rootDir: string;
  sessionId: () => string | undefined;
  busy: () => boolean;
  setStatus: (status: string) => void;
  applySwitch: (toLeaf: string) => Promise<boolean>;
  regenerateAt: (forkUuid: string) => Promise<void>;
};

export function createBranchController(deps: BranchControllerDependencies) {
  const [state, setState] = createSignal<BranchPickerState | null>(null);

  async function open(): Promise<void> {
    if (deps.busy()) {
      deps.setStatus("request in flight");
      return;
    }
    const id = deps.sessionId();
    try {
      const forks = id ? await listBranchTree(deps.rootDir, id) : [];
      const expanded = activePathExpansionKeys(forks);
      const rows = flattenBranchRows(forks, expanded);
      let activeIndex = -1;
      rows.forEach((row, index) => {
        if (row.kind === "candidate" && row.candidate.activePath) activeIndex = index;
      });
      setState({ forks, selected: Math.max(0, activeIndex), expanded, busy: false });
      deps.setStatus("candidate tree");
    } catch (error) {
      setState({ forks: [], selected: 0, expanded: [], busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function reset(): void {
    setState(null);
  }

  function handleKey(key: BranchKeyEvent): boolean {
    const picker = state();
    if (!picker) return false;
    const name = normalizeKeyName(key.name);
    if (picker.busy) return true;
    if (picker.error) {
      if (name === "escape") reset();
      return true;
    }
    if (key.ctrl && name === "b") {
      reset();
      deps.setStatus("ready");
      return true;
    }

    if (picker.confirm) return handleConfirmKey(picker, name);

    const rows = flattenBranchRows(picker.forks, picker.expanded);
    const lastIndex = rows.length - 1;
    const row = rows[picker.selected];
    if (name === "up" || name === "k") {
      setState({ ...picker, selected: Math.max(0, picker.selected - 1) });
      return true;
    }
    if (name === "down" || name === "j") {
      setState({ ...picker, selected: Math.min(lastIndex, picker.selected + 1) });
      return true;
    }
    if (name === "left" || name === "h") {
      if (row && isExpandedRow(picker, row)) {
        setState({ ...picker, expanded: picker.expanded.filter((key) => key !== row.key) });
        return true;
      }
      // Jump to the nearest shallower row (the row's parent in the tree).
      const depth = row?.depth ?? 0;
      let target = picker.selected;
      while (target > 0 && (rows[target]?.depth ?? 0) >= depth) target -= 1;
      setState({ ...picker, selected: target });
      return true;
    }
    if (name === "right" || name === "l") {
      if (row) setState({ ...picker, expanded: [...new Set([...picker.expanded, row.key])] });
      return true;
    }
    if (name === "escape") {
      reset();
      deps.setStatus("ready");
      return true;
    }
    if (name === "enter" || name === "return") {
      if (row?.kind === "candidate") void confirmSwitch(picker, row);
      if (row?.kind === "fork") {
        setState({ ...picker, expanded: [...new Set([...picker.expanded, row.key])] });
      }
      return true;
    }
    if (name === "r" && row?.kind === "fork") {
      setState({ ...picker, confirm: { kind: "regenerate", fork: row.fork, selected: 0 } });
      return true;
    }
    return true;
  }

  function isExpandedRow(picker: BranchPickerState, row: BranchRow): boolean {
    return picker.expanded.includes(row.key);
  }

  function handleConfirmKey(picker: BranchPickerState, name: string | undefined): boolean {
    const confirm = picker.confirm!;
    const options = branchConfirmOptions(confirm);
    if (name === "up" || name === "k") {
      setState({ ...picker, confirm: { ...confirm, selected: Math.max(0, confirm.selected - 1) } });
      return true;
    }
    if (name === "down" || name === "j") {
      setState({ ...picker, confirm: { ...confirm, selected: Math.min(options.length - 1, confirm.selected + 1) } });
      return true;
    }
    if (name === "escape") {
      setState({ ...picker, confirm: undefined });
      return true;
    }
    if (name === "enter" || name === "return") {
      const option = options[confirm.selected];
      if (option?.value === "nevermind") {
        setState({ ...picker, confirm: undefined });
        return true;
      }
      if (confirm.kind === "switch") void performSwitch(picker);
      else performRegenerate(confirm.fork);
      return true;
    }
    return true;
  }

  async function confirmSwitch(picker: BranchPickerState, row: Extract<BranchRow, { kind: "candidate" }>): Promise<void> {
    const fork = enclosingFork(picker, row);
    if (!fork) return;
    let diffStats: FileCheckpointDiffStats | undefined;
    try {
      const id = deps.sessionId();
      diffStats = id ? await candidateSwitchPreview(deps.rootDir, id, row.candidate.endpointUuid) : undefined;
    } catch {
      // Preview is advisory; a failed preview still allows the switch.
    }
    const current = state();
    if (!current) return;
    setState({ ...current, confirm: { kind: "switch", fork, candidate: row.candidate, selected: 0, ...(diffStats ? { diffStats } : {}) } });
  }

  function enclosingFork(picker: BranchPickerState, row: Extract<BranchRow, { kind: "candidate" }>): BranchTreeFork | undefined {
    const rows = flattenBranchRows(picker.forks, picker.expanded);
    const index = rows.findIndex((entry) => entry.key === row.key);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = rows[cursor]!;
      if (candidate.kind === "fork" && candidate.depth < row.depth) return candidate.fork;
    }
    return undefined;
  }

  async function performSwitch(picker: BranchPickerState): Promise<void> {
    const confirm = picker.confirm;
    if (!confirm || confirm.kind !== "switch" || !confirm.candidate) return;
    setState({ ...picker, busy: true });
    const target = confirm.candidate.endpointUuid;
    const ok = await deps.applySwitch(target);
    if (ok) {
      reset();
      return;
    }
    const current = state();
    if (current) setState({ ...current, busy: false, confirm: undefined });
  }

  function performRegenerate(fork: BranchTreeFork): void {
    reset();
    void deps.regenerateAt(fork.forkRecordUuid);
  }

  return { state, open, reset, handleKey };
}
