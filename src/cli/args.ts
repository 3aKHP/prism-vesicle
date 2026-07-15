export type CliInvocation = {
  args: string[];
  dangerouslySkipPermissions: boolean;
};

const DANGEROUS_SKIP_FLAG = "--dangerously-skip-permissions";

/**
 * Parse process-wide flags before command dispatch. Accept the dangerous flag
 * anywhere so npm/bun launchers do not have to preserve one exact position.
 */
export function parseCliInvocation(argv: string[]): CliInvocation {
  return {
    args: argv.filter((arg) => arg !== DANGEROUS_SKIP_FLAG),
    dangerouslySkipPermissions: argv.includes(DANGEROUS_SKIP_FLAG),
  };
}
