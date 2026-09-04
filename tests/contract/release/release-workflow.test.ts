import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean | number>;
};

type WorkflowJob = {
  if?: string;
  uses?: string;
  environment?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflowDir = join(import.meta.dir, "..", "..", "..", ".github", "workflows");
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

  test("Windows empty-project smoke executes the versioned staged binary", async () => {
    const build = await loadWorkflow("release-build.yml");
    const smoke = build.jobs.windows?.steps?.find((step) => step.run?.includes("Copy-Item prism-vesicle.exe"));
    const script = smoke?.run ?? "";

    expect(smoke?.env?.VERSION).toContain("needs.checks.outputs.version");
    expect(script).toContain('Copy-Item prism-vesicle.exe "smoke/release/prism-vesicle-windows-x64-$env:VERSION.exe"');
    expect(script).toContain('..\\release\\prism-vesicle-windows-x64-$env:VERSION.exe');
    expect(script).not.toContain("smoke/release/prism-vesicle.exe");
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

  test("publishes release candidates to next without advancing latest", async () => {
    const publish = await loadWorkflow("release.yml");

    const metadataScript = publish.jobs.metadata?.steps?.find((step) => step.run)?.run ?? "";
    expect(metadataScript).toContain("*-rc.*)");
    expect(publish.jobs.metadata?.outputs?.channel).toBe("${{ steps.release.outputs.channel }}");

    // The npm dist-tag must come from the derived channel, never a hardcoded tag.
    const npmScript =
      publish.jobs.npm?.steps?.find((step) => step.name === "Publish the verified package if it is not already present")
        ?.run ?? "";
    expect(npmScript).toContain("DIST_TAG=next");
    expect(npmScript).toContain("DIST_TAG=latest");
    expect(npmScript).toContain('npm publish --provenance --access public --tag "$DIST_TAG"');
    expect(npmScript).not.toContain("--tag latest");
  });

  test("composes the release body through the paired-CHANGELOG script", async () => {
    const publish = await loadWorkflow("release.yml");
    const job = publish.jobs["github-release"];
    const steps = job?.steps ?? [];
    const compose = steps.find((step) => step.run?.includes("compose-notes"));
    const releaseStep = steps.find((step) => step.uses === "softprops/action-gh-release@v3");

    // The body comes from scripts/release/compose-notes.ts, which interleaves
    // the version sections of CHANGELOG.md and CHANGELOG.zh-CN.md and derives
    // the compare base from the fetched tag history. Channel blocks, the
    // bilingual signing disclosure, and the slimmed standing disclosures are
    // content contracts of the script, unit-tested in
    // tests/unit/scripts/compose-notes.test.ts — not workflow text.
    expect(compose?.run).toContain('bun scripts/release/compose-notes.ts --version "$VERSION" --out release-notes.md');
    expect(compose?.env?.VERSION).toBe("${{ needs.metadata.outputs.version }}");
    const checkout = steps.find((step) => step.uses === "actions/checkout@v7");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["fetch-tags"]).toBe(true);
    expect(steps.some((step) => step.uses === "oven-sh/setup-bun@v2")).toBe(true);

    // GitHub's autogen must stay off (its compare-base fallback dumped the
    // full history into the first non-prerelease body, issue #268 item 10);
    // the body rides the composed file only.
    expect(releaseStep?.with?.body_path).toBe("release-notes.md");
    expect(releaseStep?.with?.body).toBeUndefined();
    expect(releaseStep?.with?.generate_release_notes).toBeUndefined();
    expect(releaseStep?.with?.prerelease).toBe("${{ needs.metadata.outputs.channel != 'stable' }}");
    expect(releaseStep?.with?.make_latest).toBe("${{ needs.metadata.outputs.channel == 'stable' }}");
  });

  test("uses Node 24 action runtime lines throughout CI and publication", async () => {
    const workflows = await Promise.all([
      loadWorkflow("release-build.yml"),
      loadWorkflow("release.yml"),
      loadWorkflow("close-issues.yml"),
    ]);
    const uses = workflows.flatMap((workflow) =>
      Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
      ),
    );

    // Every pinned action family must resolve to the Node 24-compatible
    // major. We assert "all occurrences match the required version" rather
    // than an exact occurrence count, so adding or reordering a job does not
    // turn a valid workflow into a contract failure.
    const requiredActions: Record<string, string> = {
      "actions/checkout@": "actions/checkout@v7",
      "actions/upload-artifact@": "actions/upload-artifact@v7",
      "actions/download-artifact@": "actions/download-artifact@v8",
      "actions/setup-node@": "actions/setup-node@v7",
      "oven-sh/setup-bun@": "oven-sh/setup-bun@v2",
      "softprops/action-gh-release@": "softprops/action-gh-release@v3",
    };
    for (const [prefix, required] of Object.entries(requiredActions)) {
      const matched = uses.filter((action) => action.startsWith(prefix));
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.every((action) => action === required)).toBe(true);
    }

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

  test("closes issues through the cross-PR bridge script", async () => {
    const workflow = await loadWorkflow("close-issues.yml");
    const job = workflow.jobs["close-released-issues"];
    const steps = job?.steps ?? [];

    expect(job?.if).toContain("github.event.pull_request.merged == true");
    expect(job?.if).toContain("startsWith(github.head_ref, 'release/')");
    // The bridge validates constituent PRs via GET /pulls/{n}; without an
    // explicit read grant the restricted permissions block defaults it to
    // none and every release merge fails with 403. The scope is the
    // hyphenated GITHUB_TOKEN permission name — an underscored key is an
    // invalid scope that silently invalidates the whole workflow (observed
    // as zero-job "No jobs were run" failure runs on every carrying push).
    expect(workflow.permissions?.["pull-requests"]).toBe("read");
    expect(workflow.permissions?.["issues"]).toBe("write");
    expect(workflow.permissions?.["pull_requests"]).toBeUndefined();
    // The bridge script must run at the exact merged release state, under the
    // pinned Bun runtime. Keyword semantics live with the script's unit tests
    // (tests/unit/scripts/close-bridged-issues.test.ts).
    expect(
      steps.some(
        (step) =>
          step.uses === "actions/checkout@v7" && step.with?.["ref"] === "${{ github.event.pull_request.merge_commit_sha }}",
      ),
    ).toBe(true);
    expect(steps.some((step) => step.uses === "oven-sh/setup-bun@v2")).toBe(true);
    expect(steps.some((step) => step.run?.includes("bun scripts/release/close-bridged-issues.ts"))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/github-script"))).toBe(false);
  });

  test("keeps every release gate in the reusable workflow", async () => {
    const build = await loadWorkflow("release-build.yml");
    const commands = Object.values(build.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");

    expect(commands).toContain("bun run lint");
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("bun test");
    expect(commands).toContain("bun audit");
    expect(commands).toContain("bun run pack:check");
    expect(commands).toContain("bun run pack:smoke");
    expect(commands).toContain("bun run build:exe linux");
    expect(commands).toContain("bun run smoke:terminal-title-pty");
    expect(commands).toContain("bun run build:exe windows");
    expect(commands).toContain("check-windows-brand.ps1");
    expect(commands).toContain("bun run build:installer");
    expect(commands).toContain("smoke-windows-installer.ps1");
    expect(build.jobs.checks?.steps?.find((step) => step.uses === "actions/checkout@v7")?.with?.lfs).toBe(true);
    expect(build.jobs.windows?.steps?.find((step) => step.uses === "actions/checkout@v7")?.with?.lfs).toBe(true);
  });
});
