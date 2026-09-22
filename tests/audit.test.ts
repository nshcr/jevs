import { test, expect } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(
  action: (root: string, audit: () => Promise<number>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "jevs-source-audit-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(
      new URL("../scripts/audit.ts", import.meta.url),
      join(root, "scripts/audit.ts"),
    );
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ version: "0.1.0", type: "module" }),
    );
    const init = Bun.spawn(["git", "init", "-q", root], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await init.exited).toBe(0);
    const audit = async () => {
      const p = Bun.spawn([process.execPath, "scripts/audit.ts"], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          TYPESAFE_API_KEY: "audit-fixture-credential-value",
        },
      });
      return p.exited;
    };
    await action(root, audit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("public audit rejects untracked private material and tracked ignored credentials", async () => {
  await fixture(async (root, audit) => {
    expect(await audit()).toBe(0);
    await Bun.write(join(root, "notes.txt"), "local note");
    expect(await audit()).not.toBe(0);
    await rm(join(root, "notes.txt"));
    await Bun.write(join(root, ".gitignore"), ".env\n");
    await Bun.write(join(root, ".env"), "PRIVATE=fixture\n");
    expect(await audit()).toBe(0);
    expect(
      await Bun.spawn(["git", "add", "-f", ".env"], { cwd: root }).exited,
    ).toBe(0);
    expect(await audit()).not.toBe(0);
  });
});

test("public audit rejects broken links, personal paths and configured credentials", async () => {
  await fixture(async (root, audit) => {
    for (const content of [
      "[missing](missing.md)",
      "/" + "Users/example/project/file",
      "audit-fixture-credential-value",
    ]) {
      await Bun.write(join(root, "README.md"), content);
      expect(await audit()).not.toBe(0);
    }
    await Bun.write(join(root, "README.md"), "[manifest](package.json)");
    expect(await audit()).toBe(0);
  });
});
