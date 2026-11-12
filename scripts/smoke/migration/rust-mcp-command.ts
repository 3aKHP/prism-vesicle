import { isAbsolute } from "node:path";

/** Cargo reports the actual executable even with target-dir or target-triple overrides. */
export function mcpExecutableFromCargo(output: string): string {
  let executable: string | undefined;
  for (const line of output.split("\n").filter(Boolean)) {
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target?.name === "vesicle-mcp-probe"
      && message.target.kind?.includes("bin") && typeof message.executable === "string") {
      if (!isAbsolute(message.executable)) throw new Error("Cargo returned a non-absolute executable");
      executable = message.executable;
    }
  }
  if (!executable) throw new Error("Cargo did not report the MCP probe executable");
  return executable;
}

export async function buildMcpProbe() {
  const settings = Bun.TOML.parse(await Bun.file("rust-toolchain.toml").text()) as { toolchain: { channel: string } };
  if (!/^\d+\.\d+\.\d+$/.test(settings.toolchain.channel)) throw new Error("Pinned Rust toolchain required");
  const build = Bun.spawn(["rustup", "run", settings.toolchain.channel, "cargo", "build", "--locked", "-p", "vesicle-mcp-probe", "--message-format=json-render-diagnostics"], { stdout: "pipe", stderr: "inherit" });
  const [output, exit] = await Promise.all([new Response(build.stdout).text(), build.exited]);
  if (exit !== 0) throw new Error("MCP probe build failed");
  return mcpExecutableFromCargo(output);
}

/** The launcher bounds the entire process, including input and SDK cleanup. */
export async function executeMcpProbe(binary: string, args: string[], input?: string) {
  const child = Bun.spawn([binary, ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit, timedOut };
  } finally { clearTimeout(timer); }
}
