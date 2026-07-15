export async function launchVesicleInProject(
  projectDirectory: string,
  compiled: boolean,
  args: string[] = [],
): Promise<number> {
  const command = compiled ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args];
  const child = Bun.spawn(command, {
    cwd: projectDirectory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
