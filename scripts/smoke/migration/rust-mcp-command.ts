import { resolve } from "node:path";

export async function buildMcpProbe() {
  const settings = Bun.TOML.parse(await Bun.file("rust-toolchain.toml").text()) as { toolchain: { channel: string } };
  if (!/^\d+\.\d+\.\d+$/.test(settings.toolchain.channel)) throw new Error("Pinned Rust toolchain required");
  const build = Bun.spawn(["rustup", "run", settings.toolchain.channel, "cargo", "build", "--locked", "-p", "vesicle-mcp-probe"], { stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("MCP probe build failed");
}

/** The launcher bounds the entire process, including input and SDK cleanup. */
export async function executeMcpProbe(args: string[], input?: string) {
  const binary = resolve("target/debug", process.platform === "win32" ? "vesicle-mcp-probe.exe" : "vesicle-mcp-probe");
  const child = Bun.spawn([binary, ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit, timedOut };
  } finally { clearTimeout(timer); }
}
