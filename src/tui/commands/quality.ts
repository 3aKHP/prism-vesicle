// /quality — experimental Semantic Judge configuration. The guided picker,
// observe/rewrite bare modes, and explicit advanced shortcut each resolve a
// judge candidate and verify its provider key before mutating settings.

import { afterAgentLoop, immediate } from "./dispatch";
import { qualityCommandCompletion } from "./argument-completion";
import {
  assertJudgeCandidateHasKey,
  defaultExperimentalQualityTimeoutMs,
  judgeCandidateHasKey,
  loadExperimentalQualitySettings,
  maxExperimentalQualityTimeoutMs,
  minExperimentalQualityTimeoutMs,
  writeExperimentalQualitySettings,
} from "../../config/quality";
import { completeQualityTuple, qualityTupleResolves, resolveQualityCandidate } from "../quality-picker-controller";
import type { Command, QualityCommandContext } from "./types";

export function createQualityCommands(ctx: QualityCommandContext): Command[] {
  return [
    {
      name: "quality",
      busyBehavior: (args) => args.trim() === "status" ? immediate : afterAgentLoop,
      description: "Show or configure the experimental Semantic Judge (no args = guided settings)",
      usage: "/quality [status|off|observe [provider model [timeout-ms]]|rewrite [provider model [timeout-ms]]]",
      completion: qualityCommandCompletion,
      async run(args, raw) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
        const parts = args.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          await ctx.openQualityPicker();
          return;
        }
        if (parts[0] === "status" && parts.length === 1) {
          const settings = await loadExperimentalQualitySettings();
          ctx.setMessages((prev) => [...prev, { role: "system", content: renderQualitySettings(settings) }]);
          return;
        }
        // /quality confirm ... is no longer supported: Rewrite opens one modal
        // confirmation panel. Reject it as invalid usage with no mutation.
        if (parts[0] === "confirm") {
          ctx.setMessages((prev) => [...prev, { role: "system", content: `${QUALITY_USAGE}\nThe /quality confirm step was removed. Selecting Review and revise (or running /quality rewrite) opens one confirmation panel; no second command is needed.` }]);
          return;
        }
        if (parts[0] === "off" && parts.length === 1) {
          await disableQuality(ctx);
          return;
        }
        const mode = parts[0];
        if (mode !== "observe" && mode !== "rewrite") {
          ctx.setMessages((prev) => [...prev, { role: "system", content: QUALITY_USAGE }]);
          return;
        }
        if (parts.length === 2 || parts.length > 4) {
          ctx.setMessages((prev) => [...prev, { role: "system", content: QUALITY_USAGE }]);
          return;
        }
        if (parts.length === 1) {
          await runBareQualityMode(ctx, mode);
          return;
        }
        // explicit advanced shortcut: /quality <mode> <provider> <model> [timeout-ms]
        const providerAlias = parts[1]!;
        const modelId = parts[2]!;
        const judgeTimeoutMs = parts.length === 4 ? parseQualityTimeout(parts[3]!) : defaultExperimentalQualityTimeoutMs;
        if (judgeTimeoutMs === undefined) {
          ctx.setMessages((prev) => [...prev, { role: "system", content: `Judge timeout must be an integer from ${minExperimentalQualityTimeoutMs} to ${maxExperimentalQualityTimeoutMs} milliseconds.` }]);
          return;
        }
        await runExplicitQualityMode(ctx, mode, providerAlias, modelId, judgeTimeoutMs);
      },
    },
  ];
}

function renderQualitySettings(settings: Awaited<ReturnType<typeof loadExperimentalQualitySettings>>): string {
  const tuple = completeQualityTuple(settings);
  if (settings.mode === "off") {
    return tuple
      ? `Experimental Semantic Judge: off (inactive). Retained profile: ${tuple.providerAlias}/${tuple.modelId} (${tuple.judgeTimeoutMs} ms). No Judge request is made while off.`
      : "Experimental Semantic Judge: off. Future turns make no Judge request.";
  }
  return `Experimental Semantic Judge: ${settings.mode} with ${settings.providerAlias}/${settings.modelId} (${settings.judgeTimeoutMs} ms). It is not calibrated production policy.`;
}

const QUALITY_USAGE = "Usage: /quality [status|off|observe [provider model [timeout-ms]]|rewrite [provider model [timeout-ms]]]. No arguments open guided settings.";

function parseQualityTimeout(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)
    || value < minExperimentalQualityTimeoutMs
    || value > maxExperimentalQualityTimeoutMs) {
    return undefined;
  }
  return value;
}

async function disableQuality(ctx: QualityCommandContext): Promise<void> {
  const settings = await loadExperimentalQualitySettings();
  const retained = completeQualityTuple(settings);
  if (retained) {
    await writeExperimentalQualitySettings({ mode: "off", providerAlias: retained.providerAlias, modelId: retained.modelId, judgeTimeoutMs: retained.judgeTimeoutMs });
  } else {
    await writeExperimentalQualitySettings({ mode: "off" });
  }
  ctx.setStatus("experimental Semantic Judge off");
  ctx.recordActivity({ kind: "system", text: "experimental Semantic Judge disabled" });
  ctx.setMessages((prev) => [...prev, {
    role: "system",
    content: retained
      ? `Experimental Semantic Judge is off. The Judge profile ${retained.providerAlias}/${retained.modelId} is retained for later reuse; no Judge request is made while off.`
      : "Experimental Semantic Judge is off. Future turns make no Judge request.",
  }]);
}

/**
 * Bare `/quality observe|rewrite` without an explicit profile. Observe enables
 * immediately only when a retained VALID profile exists (resolves and has its
 * key); a retained profile that lacks its key is not valid and falls through to
 * the guided picker. Rewrite opens the red panel for a valid retained profile
 * (or, on first use with no retained tuple, the active model); if a retained
 * profile exists but is stale or keyless it routes to the picker so the user
 * must Change Judge rather than silently enabling a substitute (plan rule 3).
 */
async function runBareQualityMode(ctx: QualityCommandContext, mode: "observe" | "rewrite"): Promise<void> {
  if (mode === "rewrite") {
    try {
      const registry = await ctx.ensureProviderRegistry();
      const settings = await loadExperimentalQualitySettings();
      const retained = completeQualityTuple(settings);
      const retainedResolves = retained ? qualityTupleResolves(retained, registry) : false;
      if (retained && (!retainedResolves || !(await judgeCandidateHasKey(retained.providerAlias, retained.modelId)))) {
        // Stale or keyless retained: require Change Judge via the picker.
        await ctx.openQualityPicker("rewrite");
        return;
      }
      // Valid retained, or first use with no retained tuple.
      const { candidate } = resolveQualityCandidate(settings, registry, ctx.activeProvider(), ctx.activeModel());
      await assertJudgeCandidateHasKey(candidate.providerAlias, candidate.modelId);
      await ctx.openQualityRewriteConfirm(candidate);
    } catch (error) {
      ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
    }
    return;
  }
  // bare observe: enable immediately only with a retained valid profile.
  try {
    const registry = await ctx.ensureProviderRegistry();
    const settings = await loadExperimentalQualitySettings();
    const retained = completeQualityTuple(settings);
    if (retained && qualityTupleResolves(retained, registry)
      && await judgeCandidateHasKey(retained.providerAlias, retained.modelId)) {
      await writeExperimentalQualitySettings({ mode: "observe", providerAlias: retained.providerAlias, modelId: retained.modelId, judgeTimeoutMs: retained.judgeTimeoutMs });
      ctx.setStatus("experimental Semantic Judge observe");
      ctx.recordActivity({ kind: "system", text: `experimental Semantic Judge observe ${retained.providerAlias}/${retained.modelId}` });
      ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental Semantic Judge observe is set to ${retained.providerAlias}/${retained.modelId} (${retained.judgeTimeoutMs} ms). It is not a calibrated production quality policy.` }]);
      return;
    }
  } catch (error) {
    ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
    return;
  }
  // No retained valid profile (absent, stale, or keyless): open the picker
  // focused on Review only. The candidate is visibly preselected by the picker.
  await ctx.openQualityPicker("observe");
}

/** Explicit `/quality observe|rewrite <provider> <model> [timeout]` advanced shortcut. */
async function runExplicitQualityMode(
  ctx: QualityCommandContext,
  mode: "observe" | "rewrite",
  providerAlias: string,
  modelId: string,
  judgeTimeoutMs: number,
): Promise<void> {
  try {
    await ctx.ensureProviderRegistry();
    await assertJudgeCandidateHasKey(providerAlias, modelId);
    if (mode === "rewrite") {
      await ctx.openQualityRewriteConfirm({ providerAlias, modelId, judgeTimeoutMs });
      return;
    }
    await writeExperimentalQualitySettings({ mode, providerAlias, modelId, judgeTimeoutMs });
    ctx.setStatus(`experimental Semantic Judge ${mode}`);
    ctx.recordActivity({ kind: "system", text: `experimental Semantic Judge ${mode} ${providerAlias}/${modelId}` });
    ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental Semantic Judge ${mode} is set to ${providerAlias}/${modelId} (${judgeTimeoutMs} ms). It is not a calibrated production quality policy.` }]);
  } catch (error) {
    ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
  }
}
