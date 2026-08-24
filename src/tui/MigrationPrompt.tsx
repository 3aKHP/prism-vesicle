import { ThemedText } from "./theme-text";
import { For } from "solid-js";
import { displayWidth, wrapDisplayLines } from "./format";
import { palette } from "./theme";
import type { MigrationReviewState } from "./session-migration-controller";

/** Cap the rendered findings so a pathological report cannot overflow the panel. */
const maxReportRows = 8;

const stageDescriptions = {
  1: "The session was recorded under a different verified Harness baseline. The report below was checked offline: no provider request was sent.",
  2: "The current session file will be copied to the session archive and rebound to the new baseline. History keeps its original records; this cannot be undone automatically.",
} as const;

export function migrationIdentityLine(state: MigrationReviewState): string {
  const from = state.report.from
    ? `${state.report.from.packId}@${state.report.from.packVersion}`
    : "an unrecorded Harness baseline";
  const to = state.report.to ? `${state.report.to.packId}@${state.report.to.packVersion}` : "unknown baseline";
  return `${from} → ${to}`;
}

export function migrationPanelHeight(state: MigrationReviewState, width: number): number {
  const inner = Math.max(20, width - 4);
  const descriptions = wrapDisplayLines(stageDescriptions[state.stage], inner).length;
  // Budget the actual wrapped report rows: the confirm options and hint must
  // never be clipped below the panel, even with many multi-line findings.
  const report = reportRows(state, inner).length + 1;
  return descriptions + report + 8;
}

function reportRows(state: MigrationReviewState, innerWidth: number): string[] {
  const ordered = [
    ...state.report.findings.filter((finding) => finding.severity === "blocking"),
    ...state.report.findings.filter((finding) => finding.severity === "warning"),
  ];
  const rows: string[] = [];
  for (const finding of ordered.slice(0, maxReportRows)) {
    rows.push(...wrapDisplayLines(`${finding.severity === "blocking" ? "✗" : "⚠"} ${finding.message}`, innerWidth));
  }
  if (ordered.length > maxReportRows) {
    rows.push(`… and ${ordered.length - maxReportRows} more finding${ordered.length - maxReportRows === 1 ? "" : "s"}`);
  }
  return rows;
}

function migrationHint(state: MigrationReviewState, width: number): string {
  if (state.report.verdict === "blocking") return "Esc close";
  const full = "↑/↓ choose · Enter confirm · Esc cancel";
  return displayWidth(full) <= Math.max(20, width - 4)
    ? full
    : "↑/↓ · Enter confirm · Esc cancel";
}

export function MigrationPrompt(props: { state: MigrationReviewState; width: number }) {
  const blocking = () => props.state.report.verdict === "blocking";
  const inner = () => Math.max(20, props.width - 4);
  return (
    <box border borderColor={palette.error} paddingX={1} flexDirection="column" width={props.width} height="100%">
      <ThemedText content={blocking()
        ? "BLOCKED · Session Harness migration"
        : `DANGER · Migrate session Harness baseline (${props.state.stage}/2)`} fg={palette.error} attributes={1} wrapMode="none" />
      <ThemedText content={migrationIdentityLine(props.state)} fg={palette.textPrimary} wrapMode="none" />
      <For each={wrapDisplayLines(stageDescriptions[props.state.stage], inner())}>{(line) => <ThemedText content={line} fg={palette.error} wrapMode="none" />}</For>
      <For each={reportRows(props.state, inner())}>{(line) => (
        <ThemedText content={line} fg={line.startsWith("✗") ? palette.error : palette.textPrimary} wrapMode="none" />
      )}</For>
      {blocking()
        ? <ThemedText content="Resolve the findings above or start a new session; migration is refused." fg={palette.textDim} wrapMode="none" />
        : props.state.busy
          ? <ThemedText content="archiving and rebinding the session…" fg={palette.error} wrapMode="none" />
          : (
            <>
              <ThemedText content={`${props.state.focused === "confirm" ? "›" : " "} ${props.state.stage === 1 ? "Continue" : "Archive and migrate session"}`} fg={props.state.focused === "confirm" ? palette.error : palette.textDim} wrapMode="none" />
              <ThemedText content={`${props.state.focused === "reject" ? "›" : " "} Cancel`} fg={props.state.focused === "reject" ? palette.textPrimary : palette.textDim} wrapMode="none" />
            </>
          )}
      <ThemedText content={migrationHint(props.state, props.width)} fg={palette.textDim} wrapMode="none" />
    </box>
  );
}
