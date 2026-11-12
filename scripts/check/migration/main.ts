import { resolve } from "node:path";
import { baselineDelta, baselineSha, scanBaseline } from "./baseline";
import { checkEvidence } from "./check";
import type { Stage } from "./model";
import { parseEvidence } from "./parse";

const [command, sourceRoot, evidencePath, evidenceRoot, requirementsPath, stage] = process.argv.slice(2);
if (command === "scan" && sourceRoot && !evidencePath) {
  console.log(JSON.stringify(await scanBaseline(resolve(sourceRoot)), null, 2));
} else if ((command === "check" || command === "diff") && sourceRoot && evidencePath) {
  const evidence: unknown = await Bun.file(evidencePath).json();
  const tsSourceSha = await baselineSha(resolve(sourceRoot));
  const baseline = await scanBaseline(resolve(sourceRoot));
  if (command === "diff") {
    const result = baselineDelta(parseEvidence(evidence).baseline, baseline);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = Object.values(result).some((rows) => rows.length) ? 1 : 0;
  } else if (evidenceRoot && requirementsPath && stage && /^S[0-6]$/.test(stage)) {
    const requirements = parseEvidence(await Bun.file(requirementsPath).json());
    const result = await checkEvidence(evidence, { root: resolve(evidenceRoot), baseline, tsSourceSha, requirements, stage: stage as Stage });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else throw new Error("check requires an explicit evidence root reviewed requirements bundle and acceptance stage");
} else {
  console.error("Usage: bun scripts/check/migration/main.ts scan <TS-checkout> | diff <TS-checkout> <evidence.json> | check <TS-checkout> <evidence.json> <evidence-root> <reviewed-coverage.json> <S0..S6>");
  process.exitCode = 2;
}
