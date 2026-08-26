/*
  Dependency license gate. Scans every package pnpm resolved from the
  lockfile (production and dev) and fails the build unless each license is
  on the allowlist or the package is a named, justified exception.

  Run: pnpm licenses list --json | node scripts/check-dep-licenses.mjs
*/

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
]);

/*
  Named exceptions, each reviewed by a human. Every entry must say why it is
  acceptable. Additions to this map require LuxAlgo review (see CODEOWNERS on
  this directory's workflows).
*/
const EXCEPTIONS = new Map([
  [
    "argparse",
    "Python-2.0 (permissive, OSI-approved); dev-only transitive of the changesets release tooling, never shipped in a published package.",
  ],
  [
    "spawndamnit",
    "package.json says SEE LICENSE IN LICENSE; the LICENSE file is verbatim MIT text. Dev-only transitive of the changesets release tooling.",
  ],
]);

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const failures = [];
  const excepted = [];
  for (const [license, packages] of Object.entries(report)) {
    if (ALLOWED.has(license)) continue;
    for (const pkg of packages) {
      const reason = EXCEPTIONS.get(pkg.name);
      if (reason) {
        excepted.push(`${pkg.name} (${license}): ${reason}`);
      } else {
        failures.push(`${pkg.name}@${(pkg.versions ?? []).join(",")}: ${license}`);
      }
    }
  }
  if (excepted.length > 0) {
    console.log("License exceptions in effect (human-reviewed):");
    for (const line of excepted) console.log(`  - ${line}`);
  }
  if (failures.length > 0) {
    console.error("Disallowed or unknown dependency licenses:");
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      "Replace the dependency, or (only with LuxAlgo review) add a justified exception in scripts/check-dep-licenses.mjs.",
    );
    process.exit(1);
  }
  console.log("Dependency licenses OK.");
});
