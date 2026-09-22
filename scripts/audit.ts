import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json";

const root = resolve(import.meta.dir, "..");
async function run(args: string[], cwd = root) {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  assert.equal(code, 0, `${args[0]} failed: ${err}`);
  return out;
}
const digest = async (path: string) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");

function safePath(path: string) {
  assert(
    path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((x) => x === ".." || x === "." || x === "") &&
      !/[\x00-\x1f]/.test(path),
    "Unsafe inventory path",
  );
}
function checkText(text: string, path: string) {
  const credential = process.env.TYPESAFE_API_KEY?.trim();
  assert(!credential || !text.includes(credential), `Credential in ${path}`);
  assert(
    !/(?:\/Users\/|\/home\/)[a-zA-Z0-9_.-]+\//.test(text),
    `Personal filesystem path in ${path}`,
  );
  assert(
    !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) &&
      !/\b(?:ghp_|github_pat_|sk_live_)[a-zA-Z0-9_]{20,}/.test(text),
    `Potential secret in ${path}`,
  );
}
async function markdownLinks(base: string, path: string) {
  const text = await Bun.file(join(base, path)).text();
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:|^#/i.test(target)) continue;
    const file = target.split("#")[0]!;
    if (!file) continue;
    assert(
      await lstat(resolve(base, dirname(path), decodeURIComponent(file))).catch(
        () => false,
      ),
      `Broken relative link in ${path}: ${target}`,
    );
  }
}
async function sourceAudit() {
  const files = [
    ...new Set(
      (
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
        .filter(Boolean),
    ),
  ];
  const roots = new Set([
    ".bun-version",
    ".editorconfig",
    ".env.example",
    ".gitignore",
    ".prettierignore",
    "LICENSE",
    "README.md",
    "bun.lock",
    "package.json",
    "tsconfig.json",
  ]);
  for (const path of files) {
    if (!(await lstat(join(root, path)).catch(() => undefined))) continue;
    safePath(path);
    assert(
      roots.has(path) ||
        /^(?:src|scripts|tests|skills|docs|packaging|\.github)\//.test(path),
      `Unexpected public source file: ${path}`,
    );
    assert(
      !/(?:^|\/)(?:\.env(?:\..+)?|\.DS_Store|node_modules|dist|artifacts|\.local)(?:\/|$)/.test(
        path,
      ) || path === ".env.example",
      `Private/generated file tracked: ${path}`,
    );
    assert(
      (await lstat(join(root, path))).isFile(),
      `Non-regular source file: ${path}`,
    );
    checkText(await Bun.file(join(root, path)).text(), path);
    if (path.endsWith(".md") && path !== "packaging/codex/README.md")
      await markdownLinks(root, path);
  }
  const existing = (
    await Promise.all(
      files.map(async (path) =>
        (await lstat(join(root, path)).catch(() => undefined)) ? path : null,
      ),
    )
  ).filter((path): path is string => path !== null);
  console.log(
    `Public source audit passed: ${existing.length} files; links, paths and secret patterns checked.`,
  );
  return existing;
}
async function marketplaceAudit() {
  const base = join(root, "artifacts/marketplace");
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({
    cwd: base,
    onlyFiles: false,
    dot: true,
    followSymlinks: false,
  })) {
    safePath(path);
    const stat = await lstat(join(base, path));
    assert(stat.isFile() || stat.isDirectory(), `Non-regular asset: ${path}`);
    if (stat.isFile()) files.push(path);
  }
  const allowed = [
    "README.md",
    "docs/providers.md",
    "build-info.json",
    "CHECKSUMS.sha256",
    ".agents/plugins/marketplace.json",
    "plugins/jevs/LICENSE",
    "plugins/jevs/.codex-plugin/plugin.json",
    "plugins/jevs/.mcp.json",
    "plugins/jevs/dist/index.js",
    "plugins/jevs/dist/third-party-notices.json",
  ];
  for await (const path of new Bun.Glob("skills/jev-mcp/**").scan({
    cwd: root,
    onlyFiles: true,
  }))
    allowed.push(`plugins/jevs/${path}`);
  assert.deepEqual(
    files.sort(),
    allowed.sort(),
    "Marketplace allowlist mismatch",
  );
  const inventory = new Set(["CHECKSUMS.sha256"]);
  for (const line of (await Bun.file(join(base, "CHECKSUMS.sha256")).text())
    .trim()
    .split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match, "Invalid checksum line");
    const path = match[2]!;
    safePath(path);
    assert(!inventory.has(path), "Duplicate checksum member");
    inventory.add(path);
    assert.equal(
      await digest(join(base, path)),
      match[1],
      `Checksum mismatch: ${path}`,
    );
  }
  assert.deepEqual([...inventory].sort(), files, "Checksum inventory mismatch");
  const info = await Bun.file(join(base, "build-info.json")).json();
  assert.equal(info.version, pkg.version);
  assert.deepEqual(
    Object.keys(info.sourceHashes).sort(),
    [...publicFiles].sort(),
    "Source inventory mismatch",
  );
  for (const path of publicFiles)
    assert.equal(
      info.sourceHashes[path],
      await digest(join(root, path)),
      `Stale source: ${path}`,
    );
  assert.deepEqual(
    await Bun.file(join(base, ".agents/plugins/marketplace.json")).json(),
    await Bun.file(join(root, "packaging/codex/marketplace.json")).json(),
  );
  assert.equal(
    await Bun.file(join(base, "docs/providers.md")).text(),
    await Bun.file(join(root, "docs/providers.md")).text(),
    "Published provider guidance differs from source",
  );
  const manifest = await Bun.file(
    join(base, "plugins/jevs/.codex-plugin/plugin.json"),
  ).json();
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, pkg.license);
  for (const path of files) {
    checkText(await Bun.file(join(base, path)).text(), path);
    if (path.endsWith(".md")) await markdownLinks(base, path);
  }
  console.log(`Marketplace audit passed: ${files.length} files.`);
}
const publicFiles = await sourceAudit();
if (process.argv.includes("--assets")) await marketplaceAudit();
