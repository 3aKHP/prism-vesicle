import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../../check/migration/check";
import { parseCorpusCase } from "./corpus-contract";

/** Read only domain facades; the source corpus is never passed as the project. */
const [source, project, scenarioPath, output] = process.argv.slice(2);
if (!source || !project || !scenarioPath || !output) throw new Error("corpus worker requires source/project/scenario/output");
const scenario = parseCorpusCase(JSON.parse(await readFile(scenarioPath, "utf8")));
const rejectNetwork = () => { throw new Error("Corpus reader must not perform network requests"); };
globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });
const session = await import(pathToFileURL(join(source, "src/core/session/store.ts")).href) as typeof import("../../../src/core/session/store");
const selection = await import(pathToFileURL(join(source, "src/core/session/selection.ts")).href) as typeof import("../../../src/core/session/selection");
const attachments = await import(pathToFileURL(join(source, "src/core/attachments/store.ts")).href) as typeof import("../../../src/core/attachments/store");
const agents = await import(pathToFileURL(join(source, "src/core/agents/store.ts")).href) as typeof import("../../../src/core/agents/store");
const skills = await import(pathToFileURL(join(source, "src/skills/loader.ts")).href) as typeof import("../../../src/skills/loader");
const processes = await import(pathToFileURL(join(source, "src/core/process/manager.ts")).href) as typeof import("../../../src/core/process/manager");
const checkpoints = await import(pathToFileURL(join(source, "src/core/checkpoints/candidate-files.ts")).href) as typeof import("../../../src/core/checkpoints/candidate-files");
const observation: Record<string, unknown> = {};
try {
  const records = await session.loadSessionRecords(project, scenario.sessionId);
  observation.recordCount = records.length;
  observation.candidateTree = selection.buildCandidateTree(records);
  observation.candidateBundles = scenario.candidateLeaves.map((leaf) => checkpoints.findCandidatePostState(records, leaf));
  const views: Record<string, unknown> = {};
  const materializedHashes: string[] = [];
  for (const head of ["default", ...scenario.heads]) {
    const snapshot = await session.loadSessionSnapshot(project, scenario.sessionId, {
      synthesizeDanglingToolResults: false,
      ...(head === "default" ? {} : { headUuid: head }),
    });
    views[head] = { snapshot, contents: snapshot.messages.map((message) => message.content), pendingQuality: snapshot.pendingQualityDecision !== undefined };
    if (scenario.materializeImages) {
      for (const message of snapshot.messages) {
        const images = await attachments.materializeMessageImages(project, message.images);
        for (const image of images ?? []) materializedHashes.push(sha256(Buffer.from(image.data!, "base64")));
      }
    }
  }
  observation.views = views;
  observation.materializedHashes = materializedHashes;
  const skillFiles = [];
  for (const path of scenario.skillPaths) {
    const loaded = await skills.loadSkill(join(project, path), "project");
    if (!loaded.parsed.ok) throw new Error(`Invalid corpus Skill: ${path}`);
    skillFiles.push({ path, bodySha256: loaded.parsed.bodySha256 });
  }
  observation.skillFiles = skillFiles;
  if (scenario.readAgents) {
    const store = new agents.AgentStore(project);
    observation.agents = await store.listByParent(scenario.sessionId);
    observation.inbox = await store.listInbox(scenario.sessionId);
  }
  if (scenario.readProcesses) observation.processes = await new processes.ProcessManager(project).list(scenario.sessionId);
} catch (error) {
  observation.error = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message.replaceAll(project, "<project>") : String(error),
    ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
  };
}
await writeFile(output, `${JSON.stringify(observation, null, 2)}\n`);
