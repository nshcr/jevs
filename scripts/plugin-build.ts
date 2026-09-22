import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import pkg from "../package.json";
import template from "../packaging/codex/plugin.json";
import mcp from "../packaging/codex/mcp.json";
const root = resolve(import.meta.dir, "..");
const stage = await mkdtemp(join(tmpdir(), "jevs plugin-"));
async function run(args: string[]) {
  const p = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code) throw Error(err + out);
  return out.trim();
}
const hash = async (path: string) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
try {
  const plugin = join(stage, "plugins/jevs");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  for (const path of ["dist", "skills/jev-mcp", "LICENSE"])
    await cp(join(root, path), join(plugin, path), { recursive: true });
  await cp(join(root, "packaging/codex/README.md"), join(stage, "README.md"));
  await mkdir(join(stage, "docs"), { recursive: true });
  await cp(join(root, "docs/providers.md"), join(stage, "docs/providers.md"));
  await Bun.write(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify({ ...template, version: pkg.version }, null, 2) + "\n",
  );
  await Bun.write(
    join(plugin, ".mcp.json"),
    JSON.stringify(mcp, null, 2) + "\n",
  );
  await mkdir(join(stage, ".agents/plugins"), { recursive: true });
  await cp(
    join(root, "packaging/codex/marketplace.json"),
    join(stage, ".agents/plugins/marketplace.json"),
  );
  const sources = (
    await run([
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
  )
    .split("\0")
    .filter(Boolean);
  const sourceHashes: Record<string, string> = {};
  for (const path of [...new Set(sources)].sort())
    if (await Bun.file(join(root, path)).exists())
      sourceHashes[path] = await hash(join(root, path));
  await Bun.write(
    join(stage, "build-info.json"),
    JSON.stringify(
      {
        version: pkg.version,
        bun: Bun.version,
        git: {
          head: await run(["git", "rev-parse", "HEAD"]),
          dirty: !!(await run(["git", "status", "--porcelain"])),
        },
        sourceHashes,
      },
      null,
      2,
    ) + "\n",
  );
  const files = [];
  for await (const path of new Bun.Glob("**/*").scan({
    cwd: stage,
    onlyFiles: true,
    dot: true,
  }))
    files.push(path);
  const sums = [];
  for (const path of files.sort())
    sums.push(`${await hash(join(stage, path))}  ${path}`);
  await Bun.write(join(stage, "CHECKSUMS.sha256"), sums.join("\n") + "\n");
  await run([
    process.execPath,
    "scripts/smoke.ts",
    join(plugin, "dist/index.js"),
  ]);
  await run([process.execPath, "scripts/plugin-smoke.ts", plugin]);
  const output = join(root, "artifacts/marketplace");
  await mkdir(join(root, "artifacts"), { recursive: true });
  await rm(output, { recursive: true, force: true });
  await cp(stage, output, { recursive: true });
  console.log(
    "Validated Codex marketplace: artifacts/marketplace (not installed or published)",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
