import { describe, expect, test } from "bun:test";
import type { EngineProfile } from "../../../src/core/engine/profile";
import { resolveBuiltInTools } from "../../../src/core/agent-loop/tool-surface";
import { permissionClassForTool } from "../../../src/core/permissions/policy";
import { hostToolDefinitions } from "../../../src/core/tools";

function fakeProfile(id: string, defaultTools: string[]): EngineProfile {
  return {
    id,
    displayName: id,
    protocolVersion: "test",
    systemPrompt: ["assets/prompts/host/runtime.md"],
    defaultTools,
    validators: [],
    stopGates: [],
    stateRoots: [],
    asset: { path: "assets/engines/test.profile.yaml", source: "project" },
  } as EngineProfile;
}

const skillTools = ["activate_skill", "read_skill_resource", "run_skill_script"];

function toolNames(profile: EngineProfile, options: { shellExecEnabled?: boolean; catalogNames?: string[] } = {}): string[] {
  return resolveBuiltInTools(
    profile,
    true,
    options.shellExecEnabled ?? false,
    "auto",
    options.catalogNames ? { catalogNames: options.catalogNames } : undefined,
  ).map((definition) => definition.function.name);
}

describe("skill tool permission classes", () => {
  test("activate_skill fails closed as mutate, resource reads observe, and scripts use skill_exec", () => {
    expect(permissionClassForTool("activate_skill")).toBe("mutate");
    expect(permissionClassForTool("read_skill_resource")).toBe("observe");
    expect(permissionClassForTool("run_skill_script")).toBe("skill_exec");
    expect(permissionClassForTool("run_skill_script")).not.toBe(permissionClassForTool("shell_exec"));
  });
});

describe("skill tool surface gating", () => {
  test("Stage stays tool-less even with a catalog", () => {
    expect(resolveBuiltInTools(fakeProfile("stage", skillTools), true, true, "auto", { catalogNames: ["alpha"] })).toEqual([]);
  });

  test("skill tools are injected for non-Stage engines regardless of profile defaultTools", () => {
    const names = toolNames(fakeProfile("runtime", ["read_file"]), { catalogNames: ["alpha"] });
    expect(names).toContain("activate_skill");
    expect(names).toContain("read_skill_resource");
    expect(names).toContain("run_skill_script");
  });

  test("declared skill tools stay off while the catalog is empty", () => {
    const names = toolNames(fakeProfile("runtime", skillTools), { shellExecEnabled: true });
    for (const tool of skillTools) expect(names).not.toContain(tool);
  });

  test("a non-empty catalog enables scripts without enabling shell_exec", () => {
    const names = toolNames(fakeProfile("runtime", skillTools), { catalogNames: ["alpha", "beta"] });
    expect(names).toContain("activate_skill");
    expect(names).toContain("read_skill_resource");
    expect(names).toContain("run_skill_script");
    expect(names).not.toContain("shell_exec");
  });

  test("activate_skill's name enum is the effective catalog", () => {
    const definitions = resolveBuiltInTools(fakeProfile("runtime", []), true, false, "auto", { catalogNames: ["alpha", "beta"] });
    const activateSkill = definitions.find((d) => d.function.name === "activate_skill")!;
    const parameters = activateSkill.function.parameters as { properties: { name: { enum: string[] } } };
    expect(parameters.properties.name.enum).toEqual(["alpha", "beta"]);
  });

  test("the static pool holds only the static skill definitions", () => {
    const names = hostToolDefinitions.map((definition) => definition.function.name);
    expect(names).toContain("read_skill_resource");
    expect(names).toContain("run_skill_script");
    expect(names).not.toContain("activate_skill");
  });

  test("unknown declared tools still throw", () => {
    expect(() => resolveBuiltInTools(fakeProfile("runtime", ["bogus_tool"]), true)).toThrow('declares unknown tool "bogus_tool"');
  });
});
