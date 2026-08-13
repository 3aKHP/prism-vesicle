/** Append ordered Host context blocks to one provider system authority. */
export function appendHostContext(base: string, ...blocks: Array<string | undefined>): string {
  const present = blocks.filter((block): block is string => Boolean(block));
  return present.length > 0 ? [base, ...present].join("\n\n") : base;
}
