import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Explicit opt-in. The workflow supplies repository-scoped credentials to Git.
// Tests use a local bare remote; preparing a marketplace never calls this script.
export async function publish(root: string, remote = "origin") {
  const run = async (args: string[], env?: Record<string, string>) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    assert.equal(code, 0, `git ${args[0]} failed: ${err}`);
    return out.trim();
  };
  assert.equal(
    await run(["status", "--porcelain"]),
    "",
    "Publish requires a clean source checkout",
  );
  const head = await run(["rev-parse", "HEAD"]);
  const market = join(root, "artifacts/marketplace");
  const info = await Bun.file(join(market, "build-info.json")).json();
  assert.equal(info.git.head, head, "Build does not match source HEAD");
  assert.equal(info.git.dirty, false, "Build was made from dirty source");
  const catalog = await Bun.file(
    join(market, ".agents/plugins/marketplace.json"),
  ).json();
  assert.equal(catalog.name, "jevs");
  const manifest = await Bun.file(
    join(market, "plugins/jevs/.codex-plugin/plugin.json"),
  ).json();
  assert.equal(manifest.version, info.version);
  const advertised = await run(["ls-remote", remote, "refs/heads/release"]);
  let parent: string | undefined;
  if (advertised) {
    await run(["fetch", "--no-tags", remote, "refs/heads/release"]);
    parent = await run(["rev-parse", "FETCH_HEAD"]);
    const previous = JSON.parse(
      await run(["show", `${parent}:build-info.json`]),
    );
    assert.equal(
      JSON.parse(
        await run(["show", `${parent}:.agents/plugins/marketplace.json`]),
      ).name,
      "jevs",
      "Release branch is not managed by Jevs",
    );
    if (previous.git.head === head) {
      assert.equal(
        await run(["show", `${parent}:CHECKSUMS.sha256`]),
        (await Bun.file(join(market, "CHECKSUMS.sha256")).text()).trim(),
        "Same source produced different assets",
      );
      console.log("Release already matches source; no push needed.");
      return;
    }
    await run(["merge-base", "--is-ancestor", previous.git.head, head]);
    assert(
      Bun.semver.order(info.version, previous.version) > 0,
      "Release version must increase",
    );
  }
  const temp = await mkdtemp(join(tmpdir(), "jevs-publish-"));
  try {
    const env = { GIT_INDEX_FILE: join(temp, "index"), GIT_WORK_TREE: market };
    await run(["read-tree", "--empty"], env);
    await run(
      ["--work-tree", market, "add", "--all", "--force", "--", market],
      env,
    );
    const tree = await run(["write-tree"], env);
    const commit = await run([
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      `Release Jevs ${info.version}\n\nSource: ${head}`,
    ]);
    // No force: concurrent writers or branch protection fail without overwriting.
    await run(["push", remote, `${commit}:refs/heads/release`]);
    console.log(`Published ${info.version} from ${head} to release`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  assert(process.argv.includes("--confirm"), "Publishing requires --confirm");
  const root = resolve(import.meta.dir, "..");
  const audit = Bun.spawn([process.execPath, "scripts/audit.ts", "--assets"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await audit.exited, 0, "Marketplace audit failed");
  await publish(root);
}
