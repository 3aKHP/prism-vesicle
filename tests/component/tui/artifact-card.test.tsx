import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ArtifactCard, } from "../../../src/tui/widgets/ArtifactCard";

describe("tui: artifact card", () => {
  test("renders structure-preserving artifact cards in the message stream", async () => {
    const setup = await testRender(() => (
      <ArtifactCard
        path="workspace/cards/mira.md"
        content="## Biography\n\nA structured preview."
        truncated={true}
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("workspace/cards/mira.md");
    expect(frame).toContain("Biography");
    expect(frame).not.toContain("## Biography");
    expect(frame).toContain("Preview truncated");
  });

});
