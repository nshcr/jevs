import pkg from "../package.json";
const pinned = (
  await Bun.file(new URL("../.bun-version", import.meta.url)).text()
).trim();
if (Bun.version !== pinned)
  throw Error(`Use Bun ${pinned}; current ${Bun.version}`);
if (pkg.packageManager !== `bun@${pinned}` || pkg.license !== "MIT")
  throw Error("Distribution/toolchain policy mismatch");
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version))
  throw Error("Invalid version");
for (const [name, version] of Object.entries({
  ...pkg.dependencies,
  ...pkg.devDependencies,
})) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw Error(`Dependency must be pinned: ${name}`);
}
console.log(`Governance passed: ${pkg.name}@${pkg.version}, Bun ${pinned}.`);
