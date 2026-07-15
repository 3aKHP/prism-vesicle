import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
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
      (step) => step.uses === "softprops/action-gh-release@v2",
    );
    const body = String(releaseStep?.with?.body ?? "");

    expect(releaseStep?.with?.generate_release_notes).toBe(true);
    expect(body).toContain("not Authenticode-signed");
    expect(body).toContain("SHA256SUMS.txt");
    expect(body).toContain("CODE_SIGNING_POLICY.md");
    expect(body).toContain("CODE_SIGNING_POLICY.zh-CN.md");
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
