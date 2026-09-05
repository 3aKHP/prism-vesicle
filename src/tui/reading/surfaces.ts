import type { BottomSurfaceMode, BottomSurfaceState } from "../views/BottomSurface";
import type { OptionItem } from "../types";
import { displayWidth, wrapDisplayLines } from "../format";
import { gateSummaryLineBudget, renderGateSummaryText, wrapGateSummary } from "../GatePrompt";
import { hostAuthorityWarning, skillScriptAuthorityWarning } from "../PermissionPrompt";
import { processShellDisplay } from "../../core/process/runtime";
import { migrationDescriptions, migrationIdentityLine } from "../MigrationPrompt";
import { yoloDescriptions } from "../YoloPrompt";
import { qualityRewriteDescriptions } from "../QualityRewritePrompt";
import { qualityDecisionItems } from "../QualityDecisionPrompt";
import { branchConfirmOptions, flattenBranchRows } from "../branch/controller";
import { rewindRestoreOptions } from "../RewindPicker";
import type { ReadingBlock, ReadingDocument } from "./document";

export type ReadingSurfaceOptions = {
  width: number;
  height: number;
  busy: boolean;
  childPermission: boolean;
  gateNoteActive?: boolean;
  engineSwitchPending?: boolean;
  permissionReject?: boolean;
  questionSelected?: number;
  skillBusy?: boolean;
  modelBusy?: boolean;
  qualityBusy?: boolean;
  gateSummary?: string;
  modelTitle: string;
  modelItems: OptionItem[];
  skillTitle: string;
  skillItems: OptionItem[];
  qualityTitle: string;
  qualityItems: OptionItem[];
};

const normal = (text: string): ReadingBlock => ({ text });
const markdown = (text: string): ReadingBlock => ({ text, format: "markdown" });
const warning = (text: string): ReadingBlock => ({ text, tone: "warning" });

/** Pure projection of already loaded, user-visible fields; never fetches or dumps runtime objects. */
export function projectReadingSurface(mode: BottomSurfaceMode, options: ReadingSurfaceOptions): ReadingDocument | null {
  const width = Math.max(1, options.width - 4);
  const make = (identity: unknown, key: string, title: string, blocks: ReadingBlock[], reserved: number, enabled = true): ReadingDocument => ({
    kind: mode.kind, identity, key, title,
    blocks: [{ text: title, tone: "title" }, ...blocks], enabled,
    hidden: displayWidth(title) > width || blocks.reduce((count, block) => count + wrapDisplayLines(block.text, width).length, 0) > Math.max(1, options.height - reserved),
  });
  const itemDocument = (identity: unknown, title: string, item: OptionItem | undefined, key: string) => {
    if (!item) return null;
    const document = make(identity, key, title, [normal(item.label), normal(item.detail ?? "")], 3);
    document.hidden ||= displayWidth(item.label) > 22 || displayWidth(item.detail ?? "") > Math.max(8, options.width - 27);
    // Picker titles share their row with the keyboard hint.
    if (displayWidth(title) > width - 39) {
      document.hidden = true;
    }
    document.hidden ||= /[\r\n]/.test(item.label + (item.detail ?? ""));
    document.enabled = mode.kind === "skill-picker" ? !options.skillBusy : mode.kind === "model" ? !options.modelBusy : !options.qualityBusy;
    return document;
  };
  const errorDocument = (identity: unknown, title: string, error: string, busy: boolean) => {
    const document = make(identity, error, title, [{ text: error, tone: "danger" }], options.height, !busy);
    document.hidden = /[\r\n]/.test(error) || displayWidth(error) > options.width - 11;
    return document;
  };
  switch (mode.kind) {
    case "composer": return null;
    case "permission": {
      const request = mode.request;
      const blocks = [normal(`${request.toolName} · mode ${request.mode} · cwd .`)];
      if (request.executionPlan) {
        blocks.push(normal(`${processShellDisplay(request.executionPlan)}${request.executionPlan.runInBackground ? " · background" : ""}`));
        if (request.executionPlan.executablePath) blocks.push(normal(`Interpreter: ${request.executionPlan.executablePath}`));
      }
      if (request.permissionClass === "arbitrary_exec") blocks.push({ text: hostAuthorityWarning, tone: "danger" });
      if (request.permissionClass === "skill_exec") blocks.push(warning(skillScriptAuthorityWarning));
      let detail = request.executionPlan?.command ?? request.arguments;
      if (!request.executionPlan) {
        try { detail = JSON.stringify(JSON.parse(detail || "{}"), null, 2); } catch { /* Display malformed arguments as received. */ }
      }
      blocks.push(normal(detail));
      const document = make(request.id, "permission", "Permission required", blocks, 6, !options.busy || options.childPermission);
      const flexible = Math.max(1, options.height - 7 - Number(Boolean(request.executionPlan?.executablePath)) - (options.permissionReject ? 2 : 0));
      const authority = request.permissionClass === "arbitrary_exec" ? hostAuthorityWarning : request.permissionClass === "skill_exec" ? skillScriptAuthorityWarning : "";
      const warningRows = authority ? wrapDisplayLines(authority, width).length : 0;
      const shownWarning = Math.min(warningRows, Math.max(0, flexible - 1));
      document.hidden = warningRows > shownWarning || wrapDisplayLines(detail, width - 1).length > flexible - shownWarning
        || (request.executionPlan?.executablePath ? displayWidth(`Interpreter: ${request.executionPlan.executablePath}`) > width : false);
      // Metadata is one compact line, including shell and background state.
      const metadata = `${request.toolName} · mode ${request.mode} · cwd .${request.executionPlan?.runInBackground ? " · background" : ""}${request.executionPlan ? ` · ${processShellDisplay(request.executionPlan)}` : ""}`;
      document.hidden ||= displayWidth(metadata) > width;
      return document;
    }
    case "gate": {
      const summary = options.gateSummary ?? mode.gate.summary;
      const blocks = [markdown(summary)];
      for (const option of mode.gate.options ?? []) blocks.push(normal(`${option.decision}: ${option.label}`));
      const document = make(mode.gate, "gate", `Stop Gate: ${mode.gate.gate}`, blocks, 6, !options.busy);
      const compactSummaryBudget = gateSummaryLineBudget(
        Math.max(1, options.height - 6),
        Boolean(options.gateNoteActive),
        Number(Boolean(options.engineSwitchPending)),
      );
      document.hidden = displayWidth(document.title) > width || wrapGateSummary(renderGateSummaryText(summary), Math.max(31, width - 1)).length > compactSummaryBudget
        || (mode.gate.options ?? []).some((item) => displayWidth(item.label) > width - 4);
      return document;
    }
    case "question": {
      const question = mode.pending.question;
      const document = make(question, "question", question.header, [markdown(question.question), ...question.options.map((item, i) => markdown(`${i + 1}. ${item.label} - ${item.description}`))], 4, !options.busy);
      const composer = question.options[options.questionSelected ?? 0]?.kind === "freeform" ? 2 : 0;
      const shownOptions = Math.max(1, Math.min(question.options.length, options.height - 4 - composer));
      document.hidden = shownOptions < question.options.length || wrapDisplayLines(question.question, width - 1).length > Math.max(1, options.height - 3 - shownOptions - composer)
        || question.options.some((item, i) => /[\r\n]/.test(item.label + item.description) || displayWidth(`${i + 1}. ${item.label} - ${item.description}`) > width - 1);
      if (/[\r\n]/.test(question.header) || displayWidth(question.header) > Math.max(8, width - 48)) {
        document.hidden = true;
      }
      return document;
    }
    case "quality": {
      const decision = mode.pending.decision;
      const document = make(decision.id, "quality", decision.reason === "interrupted" ? "Revision interrupted" : "Revision exhausted", [
        warning("Current version is not confirmed clean"),
        normal(`${decision.findingCount} findings · ${decision.producer}`),
        ...decision.targets.map((target) => normal(target.path ?? "assistant response")),
        ...qualityDecisionItems(decision).map((item) => normal(`${item.label}: ${item.detail}`)),
      ], 6, !options.busy);
      document.hidden = true; // Target and producer details are not all present in the compact list.
      return document;
    }
    case "yolo": return make("yolo", String(mode.stage), `DANGER · Enable YOLO (${mode.stage}/2)`, [{ text: yoloDescriptions[mode.stage], tone: "danger" }], 6);
    case "quality-rewrite-confirm": {
      const state = mode.state;
      const document = make(state.candidate, String(state.stage), `CONFIRM · Enable Review and Rewrite (${state.stage}/2)`, [
        normal(`Judge: ${state.candidate.providerAlias}/${state.candidate.modelId} · ${state.candidate.judgeTimeoutMs} ms`),
        { text: qualityRewriteDescriptions[state.stage], tone: "danger" },
      ], 6, !options.qualityBusy);
      document.hidden ||= displayWidth(document.blocks[1]!.text) > width;
      return document;
    }
    case "session-migration": {
      const state = mode.state;
      const document = make(state.report, String(state.stage), state.report.verdict === "blocking" ? "BLOCKED · Session Harness migration" : `DANGER · Migrate session Harness baseline (${state.stage}/2)`, [
        normal(migrationIdentityLine(state)),
        warning(migrationDescriptions[state.stage]),
        ...[...state.report.findings].sort((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking")).map((finding): ReadingBlock => ({
          text: `${finding.severity}: ${finding.message}`, tone: finding.severity === "blocking" ? "danger" : "warning",
        })),
        ...(state.report.verdict === "blocking" ? [warning("Resolve the findings or start a new session; migration is refused.")] : []),
      ], 6, !state.busy);
      document.hidden ||= displayWidth(migrationIdentityLine(state)) > width;
      return document;
    }
    case "model": return itemDocument("model", options.modelTitle, options.modelItems[mode.picker.selected], `${mode.picker.step}:${options.modelItems[mode.picker.selected]?.id}`);
    case "skill-picker": return itemDocument("skill", options.skillTitle, options.skillItems[mode.picker.selected], options.skillItems[mode.picker.selected]?.id ?? "empty");
    case "quality-picker": return itemDocument("quality-picker", options.qualityTitle, options.qualityItems[mode.picker.selected], `${mode.picker.step}:${options.qualityItems[mode.picker.selected]?.id}`);
    case "session": {
      const item = mode.picker.sessions[mode.picker.selected];
      if (!item) return null;
      return make(mode.picker.sessions, item.sessionId, "Resume Session", [
        normal(item.title ?? item.sessionId), normal(`Session: ${item.sessionId}`),
        normal(`Preview: ${item.preview}`), normal(`${item.recordCount} records · ${item.updatedAt}`),
        ...(item.pendingGate ? [normal(`Gate: ${item.pendingGate.gate}\n${item.pendingGate.summary}`)] : []),
        ...(item.pendingEngineSwitch ? [normal(`Engine: ${item.pendingEngineSwitch.targetEngine}\n${item.pendingEngineSwitch.reason}`)] : []),
        ...(item.pendingUserQuestion ? [normal(`${item.pendingUserQuestion.header}\n${item.pendingUserQuestion.question}`)] : []),
        ...(item.pendingPermission ? [normal(`Permission: ${item.pendingPermission.tool}\n${item.pendingPermission.command ?? ""}`)] : []),
        ...(item.pendingQuality ? [warning(`Quality: ${item.pendingQuality.state} · ${item.pendingQuality.findingCount} findings`)] : []),
      ], options.height);
    }
    case "rewind": {
      const state = mode.picker;
      if (state.error) return errorDocument(state.points, "Rewind error", state.error, state.busy);
      const point = state.target ?? state.points[state.selected];
      if (!point) return null;
      const blocks = [normal(point.content), normal(point.timestamp)];
      if (state.target) blocks.push(...rewindRestoreOptions(point).map((item) => normal(item.label)));
      if (point.diffStats) blocks.push(normal(`Files: ${point.diffStats.filesChanged.length} · +${point.diffStats.insertions} -${point.diffStats.deletions}`), ...point.diffStats.filesChanged.map(normal));
      if (point.diffStats?.filesChanged.length) blocks.push(warning("Rewinding does not affect files edited manually outside Vesicle tools."));
      if (point.checkpointTainted) blocks.push(warning("This turn ran a host process; its file changes may not be restored."));
      if (point.failedTurn) blocks.push(warning("This turn failed before a reply; its prompt was not delivered to the provider."));
      if (state.target) blocks.push(normal("Restore applies to the point before this message. Conversation restore forks the conversation; code restore changes files. Summarize summarizes messages after this point."));
      return make(state.points, `${state.target ? "confirm" : "list"}:${state.selected}`, "Rewind", blocks, options.height, !state.busy);
    }
    case "branch": {
      const state = mode.picker;
      if (state.error) return errorDocument(state.forks, "Candidate tree error", state.error, state.busy);
      const selected = flattenBranchRows(state.forks, state.expanded)[state.selected];
      const confirm = state.confirm;
      const candidate = confirm?.candidate ?? (selected?.kind === "candidate" ? selected.candidate : undefined);
      const fork = confirm?.fork ?? (selected?.kind === "fork" ? selected.fork : undefined);
      if (!candidate && !fork) return null;
      const blocks = [normal(candidate?.excerpt ?? fork!.promptExcerpt)];
      if (candidate) blocks.push(normal(`${candidate.authoredTurnCount} turns · ${candidate.bundleStatus} · ${candidate.ts}`));
      if (confirm) {
        blocks.push(normal(confirm.kind === "regenerate" ? "A new candidate re-runs the turn; later turns leave the active branch." : "The active branch moves to this candidate; later turns on the current path are kept but hidden."));
        blocks.push(...branchConfirmOptions(confirm).map((item) => normal(item.label)));
        if (confirm.diffStats) blocks.push(normal(`Files: ${confirm.diffStats.filesChanged.length} · +${confirm.diffStats.insertions} -${confirm.diffStats.deletions}`), ...confirm.diffStats.filesChanged.map(normal));
      }
      if (candidate?.tainted) blocks.push(warning("This branch ran a host process; some file changes may be incomplete."));
      if (candidate && candidate.bundleStatus !== "bundled") blocks.push(warning("No saved file state for this candidate: files will not switch."));
      return make(state.forks, `${confirm?.kind ?? "list"}:${candidate?.rootUuid ?? fork?.forkRecordUuid}`, "Candidate tree", blocks, options.height, !state.busy);
    }
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function liveReadingKinds(state: BottomSurfaceState): string[] {
  const presence = {
    yolo: state.yoloStage, "session-migration": state.migrationReview, permission: state.permissionRequest,
    question: state.question, quality: state.quality, gate: state.gate, rewind: state.rewind,
    branch: state.branch, session: state.session, "skill-picker": state.skillPicker,
    "quality-rewrite-confirm": state.qualityRewriteConfirm, "quality-picker": state.qualityPicker, model: state.model,
  };
  return Object.entries(presence).filter(([, value]) => Boolean(value)).map(([kind]) => kind);
}
