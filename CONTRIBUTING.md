# Contributing

Thanks for helping. The two things people most often want to fix live in very different places,
and they have different rules:

- **[Rules data](#rules-data)** - a firm's challenge ruleset being wrong or out of date. Firm data
  is served at runtime by LuxAlgo's directory, not stored in this repo; corrections start as an
  issue here, not a PR.
- **[Engine contributions](#engine-contributions)** - changing the simulator itself
  (`packages/core`, `cli`, `mcp`).

Either way: CI is the reviewer of record. Run the gates locally before pushing - everything CI
checks can be reproduced on your machine.

## Setup

```bash
pnpm install          # Node >= 20 (CI uses 22), pnpm 11 (pinned via "packageManager")
pnpm build            # topological build of all packages
pnpm test:run         # unit tests
```

---

## Rules data

Firm and challenge data is not stored in this repo. The CLI, the MCP server, and any embedding
app fetch it at runtime from LuxAlgo's public, keyless directory API
(`GET https://app.luxalgo.com/api/propfirms/list`, the data behind
[luxalgo.com/prop-firms](https://www.luxalgo.com/prop-firms/)) and adapt it into simulatable
specs with [`@luxalgo/prop-firm-sim-core/directory`](packages/core/src/directory/index.ts), a
pure module that does no network access of its own. The adapter follows a three-tier honesty
policy:

1. Structured rule columns from the directory are used verbatim.
2. Missing semantics are inferred from a row's free-text fields only when one reasonable reading
   exists, and every inferred field is disclosed in the result (`inferredFields`, provenance
   `"directory+inferred"`).
3. Ambiguity is refused: a challenge whose loss semantics cannot be established is reported as
   not simulatable rather than guessed.

What that means for contributing:

- **Directory corrections are not PRs here.** The directory is maintained by LuxAlgo's team, not
  through this repo. If the directory (or an inference built on it) disagrees with the firm's own
  page, file a
  [rule change report](https://github.com/LuxAlgo/prop-firm-sim/issues/new?template=rule-change-report.yml)
  and LuxAlgo's team fixes the data at the source. The firm's page is always authoritative - when
  the directory and the firm disagree, the directory is wrong.
- **Adapter bugs are PRs here.** Wrong or missing inference in `packages/core/src/directory` (a
  free-text pattern mapped to the wrong semantics, an unambiguous phrasing the adapter refuses, a
  structured column read incorrectly) is engine code and squarely in scope. Bring a test that pins
  the row shape you are fixing.
- **Inline specs stay fully offline.** Any ruleset, including one the directory refuses or does
  not carry, can be passed as an inline `spec` object; nothing about the directory is required to
  use or test the engine.

---

## Engine contributions

### Local gates

Run before every push - the same things CI runs:

```bash
pnpm build            # all packages compile
pnpm format:check     # prettier (fix with: pnpm format)
pnpm test:run         # unit tests, including golden + invariant suites
```

### Golden-test policy

`packages/core/tests/golden.unit.test.ts` pins full simulation results for fixed seeds. **Any
change that moves simulated numbers must update the snapshot AND justify the movement in the PR
description**: which change moved the numbers, why the new numbers are more correct, and roughly
how big the movement is. Silent drift in simulated odds is the failure mode this policy exists to
catch - a snapshot update with no justification will not be merged.

### Determinism

The engine must be reproducible: same spec + trader profile + seed ⇒ identical results, on every
platform.

- **No `Date.now()`, `new Date()`, or `Math.random()` in `packages/core`.** All randomness flows
  through the seeded `Rng` (`packages/core/src/engine/rng.ts`); anything time-like must be an
  explicit input.
- New stochastic features take their streams from the existing RNG plumbing (`pathSeed`) so runs
  stay reproducible and parallelizable.

### Browser safety

The core runs in browser Web Workers (the hosted simulator at
[luxalgo.com/prop-firms](https://www.luxalgo.com/prop-firms/)) as well as Node. **`packages/core`
must stay free of `node:*` imports** and Node-only globals. `packages/core/tests/browser-compat.unit.test.ts`
enforces this by bundling the core for the browser platform and executing it - keep it green.

### Tests

Vitest, in `packages/*/tests`. Prefer invariant tests (properties that must hold for any input)
over example tests. Never weaken an invariant or golden test to make a change pass - that is the
signal to stop and reconsider the change.

---

## Releases (changesets)

User-visible changes to the publishable packages (`core`, `cli`, `mcp`) need a changeset in the
same PR:

```bash
pnpm changeset
```

See [`.changeset/README.md`](.changeset/README.md) for what deserves one and how publishing works.

## Conduct & scope

- Keep everything factual and neutral: no marketing language, no referral or affiliate content
  anywhere in the repo.
- This project ships zero telemetry - contributions must not add any form of usage tracking,
  remote logging, or phone-home behavior.
