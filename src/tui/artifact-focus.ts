import type { ArtifactEntry } from "../core/artifacts/workbench";
import type { TuiKeyEvent } from "./decision-interaction";

export type ArtifactFocusAction = "exit" | "preview" | "previous" | "next" | "consume";

export function artifactFocusAction(key: TuiKeyEvent): ArtifactFocusAction {
  if ((key.meta || key.option) && key.name === "a") return "exit";
  if (key.name === "escape") return "exit";
  if (key.name === "up") return "previous";
  if (key.name === "down") return "next";
  if (key.name === "enter" || key.name === "return") return "preview";
  return "consume";
}

export function artifactFocusPath(
  artifacts: readonly ArtifactEntry[],
  currentPath: string | null,
  direction: -1 | 1,
): string | null {
  if (artifacts.length === 0) return null;
  const currentIndex = Math.max(0, artifacts.findIndex((artifact) => artifact.path === currentPath));
  const nextIndex = Math.max(0, Math.min(artifacts.length - 1, currentIndex + direction));
  return artifacts[nextIndex]?.path ?? null;
}

export function initialArtifactFocusPath(artifacts: readonly ArtifactEntry[], selectedPath?: string): string | null {
  return artifacts.find((artifact) => artifact.path === selectedPath)?.path ?? artifacts[0]?.path ?? null;
}
