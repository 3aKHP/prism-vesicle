import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import {
  runQualityBenchmark,
  type QualityBenchmarkCase,
  type QualityBenchmarkModel,
  type QualityBenchmarkPolicy,
  type QualityBenchmarkPricing,
} from "../../core/quality";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../../core/harness/activation";

type BenchmarkPlan = {
  schema: "quality-judge-benchmark-plan/v1";
  runId: string;
  policy: QualityBenchmarkPolicy;
  models: Array<{
    providerAlias: string;
    modelId: string;
    pricing: QualityBenchmarkPricing;
  }>;
};

export async function runQualityBenchmarkCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (flags.allowLive !== "true") {
    throw new Error("Refusing provider calls without --allow-live. Benchmark runs may incur provider charges.");
  }
  const planPath = requiredFlag(flags, "plan");
  const corpusPath = requiredFlag(flags, "corpus");
  const outputPath = requiredFlag(flags, "output");
  const reportPath = requiredFlag(flags, "report");
  const [planSource, corpusSource] = await Promise.all([readFile(planPath, "utf8"), readFile(corpusPath, "utf8")]);
  const plan = parsePlan(JSON.parse(planSource));
  const corpus = parseCorpus(corpusSource, corpusPath);
  const absoluteOutput = resolve(outputPath);
  const absoluteReport = resolve(reportPath);
  if (new Set([resolve(corpusPath), absoluteOutput, absoluteReport]).size !== 3) {
    throw new Error("Corpus, append-only output, and report paths must be distinct.");
  }
  const project = requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(process.cwd()));
  const quality = project.harness.quality;
  if (!quality?.judge) throw new Error("The active verified Harness does not provide a Semantic Judge contract.");
  const models = await Promise.all(plan.models.map(async (entry): Promise<QualityBenchmarkModel> => {
    const config = await loadConfigForSelection({ provider: entry.providerAlias, model: entry.modelId });
    if (!config.apiKey) throw new Error(`Provider ${entry.providerAlias} is missing ${config.apiKeyLabel ?? "its API key"}.`);
    return {
      providerAlias: entry.providerAlias,
      protocol: protocolName(config.provider),
      modelId: entry.modelId,
      provider: createProvider(config),
      pricing: entry.pricing,
      temperatureSupported: config.capabilities?.temperature,
      reasoningTierSupported: config.capabilities?.reasoningTier,
    };
  }));
  await mkdir(dirname(absoluteOutput), { recursive: true });
  const result = await runQualityBenchmark({
    runId: plan.runId,
    outputPath: absoluteOutput,
    cases: corpus,
    models,
    identity: {
      vesicleCommit: await gitCommit(),
      corpusSha256: sha256(corpusSource),
      runtime: quality,
    },
    policy: plan.policy,
  });
  await writeAtomic(absoluteReport, `${JSON.stringify(result.report, null, 2)}\n`);
  console.log(JSON.stringify({
    runId: plan.runId,
    evaluations: result.evaluations.length,
    output: absoluteOutput,
    report: absoluteReport,
    stoppedEarly: result.stoppedEarly,
  }));
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.`);
    const key = arg.slice(2);
    if (key === "allow-live") {
      flags.allowLive = "true";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    if (flags[key] !== undefined) throw new Error(`Duplicate --${key}.`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function requiredFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function parsePlan(value: unknown): BenchmarkPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Benchmark plan must be an object.");
  const plan = value as Partial<BenchmarkPlan>;
  if (plan.schema !== "quality-judge-benchmark-plan/v1" || !plan.runId || !plan.policy || !Array.isArray(plan.models) || plan.models.length === 0) {
    throw new Error("Benchmark plan is missing required fields.");
  }
  for (const model of plan.models) {
    if (!model || typeof model.providerAlias !== "string" || !model.providerAlias || typeof model.modelId !== "string" || !model.modelId
      || !model.pricing || !isNonNegative(model.pricing.inputUsdPerMillionTokens) || !isNonNegative(model.pricing.outputUsdPerMillionTokens)) {
      throw new Error("Benchmark plan contains an invalid model or pricing entry.");
    }
  }
  return plan as BenchmarkPlan;
}

function parseCorpus(source: string, path: string): QualityBenchmarkCase[] {
  const entries: QualityBenchmarkCase[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Corpus ${path} line ${index + 1} is not JSON.`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Corpus ${path} line ${index + 1} must be an object.`);
    const item = raw as Record<string, unknown>;
    const text = requiredString(item.text, `${path} line ${index + 1} text`);
    const candidateSha256 = typeof item.candidateSha256 === "string" ? item.candidateSha256 : sha256(text);
    if (!/^[a-f0-9]{64}$/.test(candidateSha256) || candidateSha256 !== sha256(text)) {
      throw new Error(`Corpus ${path} line ${index + 1} has an invalid candidateSha256.`);
    }
    const expectedVerdict = optionalVerdict(item.expectedVerdict, `${path} line ${index + 1}`);
    const expectedRuleIds = optionalStrings(item.expectedRuleIds, `${path} line ${index + 1} expectedRuleIds`);
    if ((expectedVerdict === "pass" && expectedRuleIds?.length) || (expectedVerdict === "rewrite" && !expectedRuleIds?.length)) {
      throw new Error(`Corpus ${path} line ${index + 1} has inconsistent expected verdict and rules.`);
    }
    entries.push({
      caseId: requiredString(item.caseId ?? item.name, `${path} line ${index + 1} case id`),
      text,
      candidateSha256,
      targetType: requiredString(item.targetType, `${path} line ${index + 1} targetType`),
      genre: requiredString(item.genre, `${path} line ${index + 1} genre`),
      modelFamily: requiredString(item.modelFamily, `${path} line ${index + 1} modelFamily`),
      lengthBucket: requiredString(item.lengthBucket, `${path} line ${index + 1} lengthBucket`),
      pov: requiredString(item.pov, `${path} line ${index + 1} pov`),
      ...(expectedVerdict ? { expectedVerdict } : {}),
      ...(expectedRuleIds ? { expectedRuleIds } : {}),
    });
  }
  if (entries.length === 0) throw new Error(`Corpus ${path} is empty.`);
  return entries;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function optionalVerdict(value: unknown, label: string): "pass" | "rewrite" | undefined {
  if (value === undefined) return undefined;
  if (value !== "pass" && value !== "rewrite") throw new Error(`${label} expectedVerdict is invalid.`);
  return value;
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} must be a string list.`);
  return [...new Set(value)].sort();
}

function protocolName(protocol: string): QualityBenchmarkModel["protocol"] {
  if (protocol === "openai-chat-compatible") return "openai-chat-completions";
  if (protocol === "anthropic-messages") return "anthropic-messages";
  if (protocol === "gemini-generate-content") return "gemini-generate-content";
  throw new Error(`Unsupported benchmark provider protocol ${protocol}.`);
}

async function gitCommit(): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const commit = output.trim();
  if (exitCode !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot resolve the current Vesicle commit for benchmark identity.");
  return commit;
}

async function writeAtomic(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${crypto.randomUUID()}`;
  try {
    await writeFile(staging, source, { encoding: "utf8", flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
