import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export const experimentRoot = resolve(import.meta.dir, "..");

export async function experimentSnapshot(
  entryPath: string,
  scriptPath: string,
) {
  const paths = [
    "package.json",
    "bun.lock",
    relative(experimentRoot, import.meta.path),
    relative(experimentRoot, scriptPath),
    ...(await Array.fromAsync(
      new Bun.Glob("src/**/*.{ts,py}").scan(experimentRoot),
    )),
    ...(await Array.fromAsync(
      new Bun.Glob("skills/jev-mcp/**/*.{md,json}").scan(experimentRoot),
    )),
  ].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(`${path}\0`);
    hash.update(await Bun.file(resolve(experimentRoot, path)).bytes());
    hash.update("\0");
  }
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: experimentRoot });
    assert.equal(result.exitCode, 0);
    return result.stdout.toString().trim();
  };
  return {
    bun: Bun.version,
    packageVersion: (
      await Bun.file(resolve(experimentRoot, "package.json")).json()
    ).version as string,
    head: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]).length > 0,
    sourceSha256: hash.digest("hex"),
    hashedFiles: paths,
    entry: {
      path: relative(experimentRoot, entryPath),
      sha256: createHash("sha256")
        .update(await Bun.file(entryPath).bytes())
        .digest("hex"),
    },
  };
}

export function pathArgument(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith("--"), `${flag} requires a path.`);
  return resolve(value);
}
