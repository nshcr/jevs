import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");
const out = join(root, "dist");
// Only replace the known generated directory.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: out,
  target: "bun",
  minify: false,
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
// Conservative license inventory: all installed packages, including build dependencies.
const rows: {
  name: string;
  version: string;
  license: unknown;
  texts: { file: string; text: string }[];
}[] = [];
for await (const file of new Bun.Glob("**/package.json").scan({
  cwd: join(root, "node_modules"),
  onlyFiles: true,
})) {
  const dir = join(root, "node_modules", file.slice(0, -"package.json".length));
  const pkg = await Bun.file(join(dir, "package.json")).json();
  if (!pkg.name || !pkg.version) continue;
  const texts = [];
  for (const name of (await readdir(dir)).sort()) {
    if (/^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)) {
      const f = Bun.file(join(dir, name));
      if (await f.exists()) texts.push({ file: name, text: await f.text() });
    }
  }
  rows.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "UNSPECIFIED",
    texts,
  });
}
rows.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
await Bun.write(
  join(out, "third-party-notices.json"),
  JSON.stringify(
    {
      scope:
        "Conservative inventory of installed runtime and build dependencies; not a minimal bundled SBOM",
      packages: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Built dist/index.js and license inventory (${rows.length} packages).`,
);
