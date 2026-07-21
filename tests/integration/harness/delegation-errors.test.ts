
import { describe, expect, test } from "bun:test";
import {
  parseHarnessDriverContract,
  normalizeHarnessAdapterError,
  validateHarnessDelegationContract,
} from "../../../src/core/harness";
import { ProviderError } from "../../../src/providers/shared/errors";
import { harnessRuntime, } from "./fixtures/harness";

describe("harness delegation: delegation errors", () => {
  test("normalizes Driver ABI error categories at the Adapter boundary", () => {
    expect(normalizeHarnessAdapterError(new Error("Permission denied by the user.")).category).toBe("denied");
    expect(normalizeHarnessAdapterError(new Error("Asset not found.")).category).toBe("not_found");
    expect(normalizeHarnessAdapterError(new Error("Concurrent write conflict.")).category).toBe("conflict");
    expect(normalizeHarnessAdapterError(new Error("Provider temporarily unavailable.")).category).toBe("transient");
    expect(normalizeHarnessAdapterError(new Error("Unsupported operation.")).category).toBe("unsupported");
    expect(normalizeHarnessAdapterError(new Error("Invalid request.")).category).toBe("invalid_request");
    expect(normalizeHarnessAdapterError(new Error("Child terminated unexpectedly.")).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Unauthorized provider.", {
      kind: "http_error",
      status: 401,
      retryable: true,
    })).category).toBe("denied");
    expect(normalizeHarnessAdapterError(new ProviderError("Missing credentials for provider.", {
      kind: "missing_credentials",
      retryable: true,
    })).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Malformed provider response.", {
      kind: "malformed_response",
      retryable: true,
    })).category).toBe("failed");
    expect(normalizeHarnessAdapterError(new ProviderError("Provider network failure.", {
      kind: "network_error",
      retryable: true,
    })).category).toBe("transient");
    for (const status of [408, 429, 500, 503]) {
      expect(normalizeHarnessAdapterError(new ProviderError(`Provider HTTP ${status}.`, {
        kind: "http_error",
        status,
      })).category).toBe("transient");
    }
  });

  test("fails closed on unsupported retry and failure-decision shapes", () => {
    const excessiveRetry = structuredClone(harnessRuntime().driver) as any;
    excessiveRetry.engines["weaver-orch"].delegations[0].retryLimit = 4;
    expect(() => parseHarnessDriverContract(excessiveRetry)).toThrow("host maximum of 3");

    const duplicateInteraction = structuredClone(harnessRuntime().driver) as any;
    duplicateInteraction.engines["weaver-orch"].interactions.push(
      structuredClone(duplicateInteraction.engines["weaver-orch"].interactions[0]),
    );
    expect(() => parseHarnessDriverContract(duplicateInteraction)).toThrow("duplicate interaction id");

    const duplicateOption = structuredClone(harnessRuntime().driver) as any;
    duplicateOption.engines["weaver-orch"].interactions[0].options[1].id = "retry";
    expect(() => parseHarnessDriverContract(duplicateOption)).toThrow("duplicate option ids");

    const missingRetry = harnessRuntime();
    missingRetry.driver.engines["weaver-orch"]!.interactions[0]!.options[0]!.id = "try-again";
    expect(() => validateHarnessDelegationContract(
      missingRetry.driver,
      missingRetry.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("must declare the retry option");

    const excessiveOptions = harnessRuntime();
    excessiveOptions.driver.engines["weaver-orch"]!.interactions[0]!.options.push(
      { id: "later", label: "Later", description: "Defer the decision." },
      { id: "skip", label: "Skip", description: "Skip the failed step." },
    );
    expect(() => validateHarnessDelegationContract(
      excessiveOptions.driver,
      excessiveOptions.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("must declare the weaver-orch.agent-failure user decision point");

    const wrongSelectBinding = harnessRuntime();
    wrongSelectBinding.adapter.operationBindings["interaction.select"] = {
      kind: "interaction-tool",
      tool: "request_confirmation",
    };
    expect(() => validateHarnessDelegationContract(
      wrongSelectBinding.driver,
      wrongSelectBinding.adapter,
      ["weaver-orch"],
      ["scene-writer", "continuity-editor", "chapter-reviewer"],
    )).toThrow("interaction.select must bind to ask_user_question");
  });

});
