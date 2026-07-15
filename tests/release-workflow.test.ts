import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean | number>;
};

type WorkflowJob = {
  uses?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

const workflowDir = join(import.meta.dir, "..", ".github", "workflows");
const reusableWorkflow = "./.github/workflows/release-build.yml";

async function loadWorkflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(await readFile(join(workflowDir, name), "utf8")) as Workflow;
}

describe("release workflow contract", () => {
  test("keeps CI and tag publication on one reusable release build", async () => {
    const [ci, publish, build] = await Promise.all([
      loadWorkflow("ci.yml"),
      loadWorkflow("release.yml"),
      loadWorkflow("release-build.yml"),
    ]);

    expect(ci.jobs.verify?.uses).toBe(reusableWorkflow);
    expect(publish.jobs.build?.uses).toBe(reusableWorkflow);
    expect(Object.keys(build.on)).toEqual(["workflow_call"]);
  });

  test("treats an annotated main-history version tag push as publication authorization", async () => {
    const publish = await loadWorkflow("release.yml");
    const metadataScript = publish.jobs.metadata?.steps?.find((step) => step.run)?.run ?? "";

    expect(Object.keys(publish.on)).toEqual(["push"]);
    expect(publish.on.push).toEqual({ tags: ["v*"] });
    expect(metadataScript).toContain('test "$VERSION" = "1.0.0-alpha.2"');
    expect(metadataScript).toContain('test "$TAG" = "v$VERSION"');
    expect(metadataScript).toContain('git cat-file -t "refs/tags/$TAG"');
    expect(metadataScript).toContain("git merge-base --is-ancestor");
    expect(publish.jobs["github-release"]?.environment).toBeUndefined();
    expect(publish.jobs["github-release"]?.permissions).toEqual({ contents: "write" });
    expect(publish.jobs.npm?.environment).toBe("npm");
    expect(publish.jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("discloses the unsigned Windows alpha artifacts in generated release notes", async () => {
    const publish = await loadWorkflow("release.yml");
    const releaseStep = publish.jobs["github-release"]?.steps?.find(
      (step) => step.uses === "softprops/action-gh-release@v3",
    );
    const body = String(releaseStep?.with?.body ?? "");

    expect(releaseStep?.with?.generate_release_notes).toBe(true);
    expect(body).toContain("1.0.0-alpha.2");
    expect(body).toContain("not Authenticode-signed");
    expect(body).toContain("没有 Authenticode 签名");
    expect(body).toContain("SHA256SUMS.txt");
    expect(body).toContain("CODE_SIGNING_POLICY.md");
    expect(body).toContain("CODE_SIGNING_POLICY.zh-CN.md");
  });

  test("uses Node 24 action runtime lines throughout CI and publication", async () => {
    const workflows = await Promise.all([
      loadWorkflow("release-build.yml"),
      loadWorkflow("release.yml"),
    ]);
    const uses = workflows.flatMap((workflow) =>
      Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
      ),
    );

    expect(uses.filter((action) => action.startsWith("actions/checkout@"))).toEqual([
      "actions/checkout@v7",
      "actions/checkout@v7",
      "actions/checkout@v7",
      "actions/checkout@v7",
      "actions/checkout@v7",
    ]);
    expect(uses.filter((action) => action.startsWith("actions/upload-artifact@"))).toEqual([
      "actions/upload-artifact@v7",
      "actions/upload-artifact@v7",
    ]);
    expect(uses.filter((action) => action.startsWith("actions/download-artifact@"))).toEqual([
      "actions/download-artifact@v8",
    ]);
    expect(uses.filter((action) => action.startsWith("actions/setup-node@"))).toEqual([
      "actions/setup-node@v7",
    ]);
    expect(uses.filter((action) => action.startsWith("oven-sh/setup-bun@"))).toEqual([
      "oven-sh/setup-bun@v2",
      "oven-sh/setup-bun@v2",
      "oven-sh/setup-bun@v2",
      "oven-sh/setup-bun@v2",
    ]);
    expect(uses.filter((action) => action.startsWith("softprops/action-gh-release@"))).toEqual([
      "softprops/action-gh-release@v3",
    ]);

    const publish = workflows[1];
    const downloadArtifact = publish?.jobs["github-release"]?.steps?.find(
      (step) => step.uses === "actions/download-artifact@v8",
    );
    expect(downloadArtifact?.with?.["digest-mismatch"]).toBe("error");

    const setupNode = publish?.jobs.npm?.steps?.find(
      (step) => step.uses === "actions/setup-node@v7",
    );
    expect(setupNode?.with?.["node-version"]).toBe("24");
  });

  test("keeps every release gate in the reusable workflow", async () => {
    const build = await loadWorkflow("release-build.yml");
    const commands = Object.values(build.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");

    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("bun test");
    expect(commands).toContain("bun audit");
    expect(commands).toContain("bun run pack:check");
    expect(commands).toContain("bun run pack:smoke");
    expect(commands).toContain("bun run build:exe linux");
    expect(commands).toContain("bun run build:exe windows");
    expect(commands).toContain("bun run build:installer");
    expect(commands).toContain("smoke-windows-installer.ps1");
  });
});
