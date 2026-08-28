/** Convert an npm semver (including prerelease suffixes) to PE VersionInfo. */
export function numericFileVersion(version: string): string {
  const parts = version.split("-", 1)[0].split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error(`Cannot derive a Windows file version from ${version}.`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}
