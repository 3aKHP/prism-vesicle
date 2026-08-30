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

  test("composes channel-aware bilingual release notes with the standing disclosures", async () => {
    const publish = await loadWorkflow("release.yml");
    const job = publish.jobs["github-release"];
    const notes = job?.steps?.find((step) => step.name === "Compose channel-aware release notes")?.run ?? "";
    const releaseStep = job?.steps?.find((step) => step.uses === "softprops/action-gh-release@v3");

    // Every supported channel writes its own section and an unknown channel fails closed.
    expect(notes).toContain("Release candidate channel and known limits / RC 频道与已知限制");
    expect(notes).toContain("Beta channel and known limits / Beta 频道与已知限制");
    expect(notes).toContain("Stable channel and known limits / 稳定频道与已知限制");
    expect(notes).toContain("Unsupported release channel");
    // RC wording must steer consumers to next while latest keeps tracking the beta line.
    expect(notes).toContain("npm install -g prism-vesicle@next");
    // Standing disclosures stay attached to every channel.
    expect(notes).toContain("npm install -g prism-vesicle");
    expect(notes).toContain("deepseek-subset-2026-08-19");
    expect(notes).toContain("MCP resource, audio, URL/link");
    expect(notes).toContain("not Authenticode-signed");
    expect(notes).toContain("没有 Authenticode 签名");
    expect(notes).toContain("SHA256SUMS.txt");
    expect(notes).toContain("CODE_SIGNING_POLICY.md");
    expect(notes).toContain("CODE_SIGNING_POLICY.zh-CN.md");
    // The version placeholder must be resolved before the body reaches the release.
    expect(notes).toContain("s/%VERSION%/$VERSION/g");

    expect(releaseStep?.with?.body).toBe("${{ steps.notes.outputs.body }}");
    expect(releaseStep?.with?.generate_release_notes).toBe(true);
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
      "actions/github-script@": "actions/github-script@v9",
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

  test("closes only issues explicitly declared by a merged release PR", async () => {
    const workflow = await loadWorkflow("close-issues.yml");
    const job = workflow.jobs["close-released-issues"];
    const script = job?.steps?.find((step) => step.uses === "actions/github-script@v9")?.with?.script;

    expect(job?.if).toContain("github.event.pull_request.merged == true");
    expect(job?.if).toContain("startsWith(github.head_ref, 'release/')");
    expect(script).toContain("collect(pr.body)");
    expect(script).not.toContain("compareCommits");

    const explicitClosingLine = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\s*[.!]?\s*$/gim;
    const candidates = (text: string) => [...text.matchAll(explicitClosingLine)].map((match) => Number(match[1]));
    expect(candidates("Closes #225\nFixes #226.")).toEqual([225, 226]);
    expect(candidates("Should-fix #123\nbugfix #124\nMention fixes #125 in prose.")).toEqual([]);
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
