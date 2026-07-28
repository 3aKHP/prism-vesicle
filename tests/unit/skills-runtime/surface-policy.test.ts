import { describe, expect, test } from "bun:test";
import type { EngineProfile } from "../../../src/core/engine/profile";
import { resolveBuiltInTools } from "../../../src/core/agent-loop/tool-surface";
import { resolveShellProfile } from "../../../src/core/process/shell-profile";
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
  test("activate_skill fails closed as mutate, resource reads observe, scripts share shell_exec's class", () => {
    expect(permissionClassForTool("activate_skill")).toBe("mutate");
    expect(permissionClassForTool("read_skill_resource")).toBe("observe");
    expect(permissionClassForTool("run_skill_script")).toBe("arbitrary_exec");
    expect(permissionClassForTool("run_skill_script")).toBe(permissionClassForTool("shell_exec"));
  });
});

describe("skill tool surface gating", () => {
  test("Stage stays tool-less even with a catalog", () => {
    expect(resolveBuiltInTools(fakeProfile("stage", skillTools), true, true, "auto", { catalogNames: ["alpha"] })).toEqual([]);
  });

  test("skill tools are absent without Engine opt-in, even with a catalog", () => {
    const names = toolNames(fakeProfile("runtime", ["read_file"]), { shellExecEnabled: true, catalogNames: ["alpha"] });
    for (const tool of skillTools) expect(names).not.toContain(tool);
  });

  test("declared skill tools stay off while the catalog is empty", () => {
    const names = toolNames(fakeProfile("runtime", skillTools), { shellExecEnabled: true });
    for (const tool of skillTools) expect(names).not.toContain(tool);
  });

  test("a non-empty catalog enables activate/read; scripts additionally need process capability", () => {
    const withoutProcess = toolNames(fakeProfile("runtime", skillTools), { catalogNames: ["alpha", "beta"] });
    expect(withoutProcess).toContain("activate_skill");
    expect(withoutProcess).toContain("read_skill_resource");
    expect(withoutProcess).not.toContain("run_skill_script");

    const shellAvailable = Boolean(resolveShellProfile("auto"));
    const withProcess = toolNames(fakeProfile("runtime", skillTools), { shellExecEnabled: true, catalogNames: ["alpha", "beta"] });
    expect(withProcess.includes("run_skill_script")).toBe(shellAvailable);
  });

  test("activate_skill's name enum is the effective catalog", () => {
    const definitions = resolveBuiltInTools(fakeProfile("runtime", ["activate_skill"]), true, false, "auto", { catalogNames: ["alpha", "beta"] });
    const parameters = definitions[0]!.function.parameters as { properties: { name: { enum: string[] } } };
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
