import { describe, expect, test } from "bun:test";
import { createInitialSetupState, setupChoiceItems, transitionSetup, type SetupState } from "../../../src/setup/setup-state";

describe("Setup transitions", () => {
  test("discovery failure remains retryable without renderer or network", () => {
    let state = createInitialSetupState({}, "base-url");
    state = transitionSetup(state, { type: "submit-input", value: "https://api.example.com" }, {}).state;
    const discovery = transitionSetup(state, { type: "submit-input", value: "secret" }, {});
    expect(discovery.effect).toEqual({
      kind: "discover-models",
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
    });

    state = transitionSetup(discovery.state, { type: "effect-result", result: { kind: "discovery-failed", error: "HTTP 503" } }, {}).state;
    expect(state.step).toBe("discovery-error");
    const retry = transitionSetup(state, { type: "choose" }, {});
    expect(retry.state.step).toBe("discovering");
    expect(retry.effect?.kind).toBe("discover-models");
  });

  test("MCP auth paths return to the URL without losing the server draft", () => {
    let state: SetupState = {
      ...createInitialSetupState({}, "mcp-auth"),
      mcpDraft: { name: "Research", url: "https://mcp.example.com/mcp", auth: "none", enabledEngines: ["etl"] },
      selectedIndex: 1,
    };
    state = transitionSetup(state, { type: "choose" }, {}).state;
    expect(state.step).toBe("mcp-secret");
    expect(state.mcpDraft.auth).toBe("bearer");

    state = transitionSetup(state, { type: "back" }, {}).state;
    expect(state.step).toBe("mcp-auth");
    state = transitionSetup(state, { type: "back" }, {}).state;
    expect(state.step).toBe("mcp-url");
    expect(state.input.value).toBe("https://mcp.example.com/mcp");
    expect(state.mcpDraft.name).toBe("Research");
  });

  test("review Back restores the matching project choice", () => {
    let state = { ...createInitialSetupState({}, "review"), projectDirectory: "C:\\Story" };
    state = { ...state, selectedIndex: setupChoiceItems(state).length - 1 };
    state = transitionSetup(state, { type: "choose" }, {}).state;
    expect(state.step).toBe("project-choice");
    expect(state.selectedIndex).toBe(1);
  });

  test("save errors return an explicit retry effect", () => {
    let state: SetupState = {
      ...createInitialSetupState({}, "review"),
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret",
      selectedModels: ["model-a"],
      defaultModel: "model-a",
      projectDirectory: "",
    };
    const saving = transitionSetup(state, { type: "choose" }, {});
    expect(saving.effect?.kind).toBe("save-configuration");
    state = transitionSetup(saving.state, { type: "effect-result", result: { kind: "save-failed", error: "disk full" } }, {}).state;
    expect(state.step).toBe("save-error");

    const retry = transitionSetup(state, { type: "choose" }, {});
    expect(retry.state.step).toBe("saving");
    expect(retry.effect?.kind).toBe("save-configuration");
  });
});
