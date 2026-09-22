import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish } from "../scripts/publish.ts";

test("release branch publishes locally, updates safely and rejects stale or reused versions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "jevs-release-test-"));
  const root = join(temp, "source"),
    remote = join(temp, "remote.git");
  async function git(args: string[], cwd = root) {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if (code) throw Error(err);
    return out.trim();
  }
  try {
    await mkdir(root);
    await git(["init", "-q"]);
    await git(["config", "user.name", "Release fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await git(["init", "--bare", "-q", remote]);
    await git(["remote", "add", "origin", remote]);
    await Bun.write(join(root, ".gitignore"), "artifacts/\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "initial"]);
    const first = await git(["rev-parse", "HEAD"]);
    async function build(version: string, source?: string) {
      source ??= await git(["rev-parse", "HEAD"]);
      const dir = join(root, "artifacts/marketplace");
      await mkdir(join(dir, ".agents/plugins"), { recursive: true });
      await mkdir(join(dir, "plugins/jevs/.codex-plugin"), { recursive: true });
      await Bun.write(
        join(dir, "build-info.json"),
        JSON.stringify({ version, git: { head: source, dirty: false } }),
      );
      await Bun.write(
        join(dir, ".agents/plugins/marketplace.json"),
        JSON.stringify({ name: "jevs" }),
      );
      await Bun.write(
        join(dir, "plugins/jevs/.codex-plugin/plugin.json"),
        JSON.stringify({ version }),
      );
      await Bun.write(
        join(dir, "CHECKSUMS.sha256"),
        `fixture ${version} ${source}\n`,
      );
    }
    await build("0.1.0");
    await Bun.write(join(root, "uncommitted.txt"), "dirty");
    await expect(publish(root)).rejects.toThrow("clean source checkout");
    await rm(join(root, "uncommitted.txt"));
    await publish(root);
    const initial = await git(["rev-parse", "refs/heads/release"], remote);
    const files = await git(["ls-tree", "-r", "--name-only", initial], remote);
    expect(files).toContain(".agents/plugins/marketplace.json");
    expect(files).not.toContain(".gitignore");
    await publish(root);
    expect(await git(["rev-parse", "refs/heads/release"], remote)).toBe(
      initial,
    );
    const checksumPath = join(root, "artifacts/marketplace/CHECKSUMS.sha256");
    const checksum = await Bun.file(checksumPath).text();
    await Bun.write(checksumPath, "altered");
    await expect(publish(root)).rejects.toThrow("different assets");
    await Bun.write(checksumPath, checksum);
    await Bun.write(join(root, "source.txt"), "next");
    await git(["add", "."]);
    await git(["commit", "-qm", "next"]);
    await build("0.1.0");
    await expect(publish(root)).rejects.toThrow("version must increase");
    await build("0.1.1");
    await publish(root);
    const next = await git(["rev-parse", "refs/heads/release"], remote);
    expect(await git(["rev-parse", `${next}^`], remote)).toBe(initial);
    await git(["checkout", "--detach", first]);
    await build("0.1.2");
    await expect(publish(root)).rejects.toThrow();
    expect(await git(["rev-parse", "refs/heads/release"], remote)).toBe(next);
    expect(await git(["status", "--porcelain"])).toBe("");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
