import type { VesicleImageAttachment } from "../providers/shared/types";
import type { ComposerElement } from "./composer";

export type PromptHistoryEntry = {
  value: string;
  elements: ComposerElement[];
  images: VesicleImageAttachment[];
};

export function composerElementsForImages(value: string, images: VesicleImageAttachment[]): ComposerElement[] {
  const matches = [...value.matchAll(/\[Image #\d+\]/g)];
  return images.flatMap((image, index) => {
    const match = matches[index];
    if (!match || match.index === undefined) return [];
    return [{
      type: "image" as const,
      attachmentId: image.id,
      placeholder: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }];
  });
}
