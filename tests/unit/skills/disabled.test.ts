import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disabledPathForScope, readDisabledNames, setDisabled, userDisabledPath } from "../../../src/skills";
import { startWorkerBarrier } from "../../support/worker-barrier";

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-skill-disabled-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skill disabled state", () => {
  test("readDisabledNames returns empty set for a missing file", async () => {
    await withTemp(async (dir) => {
      const names = await readDisabledNames(join(dir, "nonexistent"));
      expect(names.size).toBe(0);
    });
  });

  test("readDisabledNames trims whitespace and ignores empty lines", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await writeFile(path, "  alpha \n\n  beta  \n\n", "utf8");
      const names = await readDisabledNames(path);
      expect(names).toEqual(new Set(["alpha", "beta"]));
    });
  });

  test("setDisabled adds a name and round-trips", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await setDisabled(path, "my-skill", true);
      const names = await readDisabledNames(path);
      expect(names.has("my-skill")).toBe(true);
    });
  });

  test("setDisabled initializes a missing parent directory", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, "missing", ".disabled");
      await setDisabled(path, "my-skill", true);
      expect(await readDisabledNames(path)).toEqual(new Set(["my-skill"]));
    });
  });

  test("concurrent updates to one file preserve every name", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await Promise.all([
        setDisabled(path, "alpha", true),
        setDisabled(path, "beta", true),
      ]);
      expect(await readDisabledNames(path)).toEqual(new Set(["alpha", "beta"]));
    });
  });

  test("cross-process updates to one file preserve every name", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, "missing", ".disabled");
      const disabledModule = join(import.meta.dir, "../../../src/skills/disabled.ts");
      const barrier = await startWorkerBarrier(dir);
      const workerScript = barrier.workerScript({
        imports: [`import { setDisabled } from ${JSON.stringify(disabledModule)};`],
        payload: ["await setDisabled(process.env.DISABLED_PATH!, process.env.SKILL_NAME!, true);"],
      });
      const expected = Array.from({ length: 16 }, (_, index) => `skill-${index}`);
      const workers = expected.map((name, index) => Bun.spawn({
        cmd: [process.execPath, "-e", workerScript],
        env: {
          ...process.env,
          ...barrier.workerEnv(index),
          DISABLED_PATH: path,
          SKILL_NAME: name,
        },
        stdout: "pipe",
        stderr: "pipe",
      }));
      try {
        await barrier.releaseWhenReady(expected.length);
        const results = await barrier.collect(workers);
        expect(results).toEqual(expected.map(() => ({ exitCode: 0, stderr: "" })));
        expect(await readDisabledNames(path)).toEqual(new Set(expected));
      } finally {
        await barrier.shutdown(workers);
      }
    });
  }, 15_000);

  test("setDisabled removes a name", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await setDisabled(path, "gone", true);
      await setDisabled(path, "gone", false);
      const names = await readDisabledNames(path);
      expect(names.size).toBe(0);
    });
  });

  test("removing the last name deletes the file", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await setDisabled(path, "only", true);
      await setDisabled(path, "only", false);
      const content = await readFile(path, "utf8").catch(() => undefined);
      expect(content).toBeUndefined();
    });
  });

  test("multiple names are sorted", async () => {
    await withTemp(async (dir) => {
      const path = join(dir, ".disabled");
      await setDisabled(path, "zeta", true);
      await setDisabled(path, "alpha", true);
      const content = await readFile(path, "utf8");
      expect(content).toBe("alpha\nzeta\n");
    });
  });

  test("disabledPathForScope maps host to the user disabled-names file", () => {
    const env = { HOME: "/fake-home", XDG_CONFIG_HOME: "" };
    const hostPath = disabledPathForScope("host", "/project", env as NodeJS.ProcessEnv);
    const userPath = userDisabledPath(env as NodeJS.ProcessEnv);
    expect(hostPath).toBe(userPath);
  });

  test("disabledPathForScope returns undefined for harness", () => {
    const env = { HOME: "/fake-home", XDG_CONFIG_HOME: "" };
    expect(disabledPathForScope("harness", "/project", env as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
