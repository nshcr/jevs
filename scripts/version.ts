const version = process.argv.filter((v) => v !== "--")[2];
if (
  !version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
    version,
  )
) {
  throw new Error(
    "Usage: bun run version:set -- 0.1.0 (release or prerelease version)",
  );
}
const path = new URL("../package.json", import.meta.url);
const pkg = await Bun.file(path).json();
pkg.version = version;
await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Version set to ${version}.`);
