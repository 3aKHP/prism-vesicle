export async function launchVesicleInProject(
  projectDirectory: string,
  compiled: boolean,
): Promise<number> {
  const command = compiled ? [process.execPath] : [process.execPath, Bun.main];
  const child = Bun.spawn(command, {
    cwd: projectDirectory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
