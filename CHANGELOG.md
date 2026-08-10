## [4.0.4](https://github.com/GMOD/hclust/compare/v4.0.3...v4.0.4) (2026-08-10)

### Bug Fixes

- Track the wasm bundle where its siblings do, not a copy of it

### Chores

- Type-check the tests and enforce prettier, as @gmod/bam does
- Let npm publish stop auto-correcting repository.url
- Exempt our own packages from the release quarantine
- Bump pnpm/action-setup to v6.0.10 and setup-emsdk to v16
- Align the workflow with the shape every other gmod repo uses
- Emscripten 5.0.0 -> 6.0.6, bundle rebuilt
- Gate preversion on format:check, as CI does
- Gate preversion on typecheck too, as CI does
- Converge package.json on the shape its siblings use

## [4.0.3](https://github.com/GMOD/hclust/compare/v4.0.2...v4.0.3) (2026-08-04)

### Bug Fixes

- Format the generated changelog, so a release can reach publish

## [4.0.2](https://github.com/GMOD/hclust/compare/v4.0.1...v4.0.2) (2026-08-04)

### Bug Fixes

- Quote node names in toNewick, and read quoted labels in fromNewick

### Chores

- Add git-cliff for changelog generation

### Documentation

- Mark breaking changes in the generated changelog

### Other Changes

- Backfill changelog

## [4.0.1](https://github.com/GMOD/hclust/compare/v4.0.0...v4.0.1) (2026-07-25)

### Chores

- Set pnpm minimumReleaseAge to 3 days
- Sha-pin actions, take pnpm version from packageManager, node 24
- Pin pnpm, declare sideEffects, drop yarn from scripts

## [4.0.0](https://github.com/GMOD/hclust/compare/v3.0.14...v4.0.0) (2026-07-17)

### Chores

- Ban TS parameter properties for type-strippable output

### Features

- Report progress as structured counts instead of a preformatted string

## [3.0.14](https://github.com/GMOD/hclust/compare/v3.0.13...v3.0.14) (2026-05-19)

### Chores

- Rename merged workflow back to publish.yml for npm OIDC trust

## [3.0.13](https://github.com/GMOD/hclust/compare/v3.0.12...v3.0.13) (2026-05-19)

### Chores

- Merge publish into ci workflow, gate on test job success

## [3.0.12](https://github.com/GMOD/hclust/compare/v3.0.11...v3.0.12) (2026-05-08)

### Features

- Accept ArrayLike<number> for cluster data rows

### Other Changes

- Format

## [3.0.11](https://github.com/GMOD/hclust/compare/v3.0.10...v3.0.11) (2026-04-28)

### Other Changes

- Improve numerical stability of UPGMA distance computations

- Accumulate Euclidean squared sum in double across four partials to avoid
  catastrophic cancellation on long vectors
- Compute Lance-Williams weights and multiply-add in double so n-1 chained
  merges don't accumulate float32 rounding error in the distance matrix
- Clamp merge heights to be non-decreasing along root-ward paths, removing rare
  negative branch lengths from float drift on near-tied data
- Reject non-finite input up front instead of silently producing a wrong tree

## [3.0.10](https://github.com/GMOD/hclust/compare/v3.0.9...v3.0.10) (2026-04-28)

### Other Changes

- Replace v3.0.4 dev-dependency with snapshot fixtures

The v3.0.4 compat tests previously imported @gmod/hclust@3.0.4 via a package
alias. Capture v3.0.4's outputs once into test/v304-snapshots.json and compare
against those fixtures instead — drops the devDep so we can publish cleanly.

- test/v304-snapshots.json: depth, lopsidedness, sorted heights, and K=2..5
  partitions for each dataset, captured from v3.0.4 output.
- test/v304-datasets.ts: shared dataset definitions, used by both the test and
  the regenerator.
- scripts/regen-v304-snapshots.ts: one-off generator. Documents the pnpm add /
  run / pnpm remove dance for refreshing the fixtures.

## [3.0.9](https://github.com/GMOD/hclust/compare/v3.0.8...v3.0.9) (2026-04-28)

### Other Changes

- Fix find-min tie-breaking that produced caterpillar trees on sparse data

c896acb's perf rewrite kept strict < comparison in the find-min loop, so when
the distance matrix had many tied values (sparse / many-duplicate input rows
like BigWig coverage or variant density), the lowest-numbered slot would absorb
every tied neighbor in sequence — producing a near-caterpillar dendrogram.
v3.0.4 happened to avoid this because newly- merged clusters were appended to
the end of its shifting array and so were considered last in find-min iteration.

Add an explicit tie-break: on equal distance, prefer the pair with smallest
combined cluster size. Yields balanced merges of tied points, matching v3.0.4's
shape on real-world variant data (1094 leaves: depth 192→39, lopsidedness
54472→18545, vs v3.0.4's 39 / 18793).

Add v3.0.4 compat tests using @gmod/hclust@3.0.4 aliased as a devDep, covering
gaussian, three-cluster, and sparse-duplicate inputs. The sparse cases are the
actual regression for this bug.

## [3.0.8](https://github.com/GMOD/hclust/compare/v3.0.7...v3.0.8) (2026-04-28)

### Other Changes

- Switch the native progress-check clock from `clock()` (CPU time, which under
  Emscripten doesn't advance the way wall-clock time does) to
  `emscripten_get_now()` (wall-clock milliseconds), so the 100ms
  progress-callback interval in `hierarchicalCluster`'s distance-matrix and
  merge loops actually fires on a real-time cadence

## [3.0.7](https://github.com/GMOD/hclust/compare/v3.0.6...v3.0.7) (2026-04-28)

### Other Changes

- Add LICENSE file
- Restore v3.0.4 dendrogram shape; remove linked-list order tracking

The Lance-Williams perf rewrite in c896acb made the lower-numbered slot always
absorb, so slot 0 grew into a giant subtree that got placed as the left child at
every merge — the dendrogram visually degenerated into a caterpillar. Leaf order
was biased the same way, ending up roughly sorted by sample index instead of
following tree traversal.

- rebuildTree now places the smaller subtree on the left at every merge and
  derives leafOrder from a left-to-right traversal of the result, matching
  v3.0.4's visual layout.
- Drop the linked-list order tracking from distance.c (3 mallocs, init, splice,
  output walk) and the outOrder parameter — leafOrder is built on the JS side
  from the tree.
- distance.c perf pass: precompute Lance-Williams weights once per merge (saves
  O(n²) divisions), hoist row pointers in find-min and LW update, add
  **restrict** to euclideanDistance, size_t casts on index math, goto-cleanup
  pattern for single-exit error handling.

## [3.0.6](https://github.com/GMOD/hclust/compare/v3.0.5...v3.0.6) (2026-04-27)

### Other Changes

- Correctness, simplicity, and test coverage improvements

- Fix clustersGivenK to have N elements (was N+1 with a trailing empty array)
- Avoid intermediate array allocations in clustersGivenK building; mutate
  membership arrays in place
- Remove {} as ClusterNode typecasts in fromNewick via newNode() helper,
  eliminating the fillDefaults post-pass entirely
- Simplify treeToJSON to return ClusterNode directly
- Add explicit case ';' in fromNewick switch
- Add integration tests: K=3 partition, order permutation, progress callbacks,
  equal-distance determinism, clusterObject label propagation
- Fix README Algorithm section (was describing old O(n³) pure-JS version;
  current C code uses Lance-Williams recurrence, same as R hclust)
- Add UPGMA and Lance-Williams citations to distance.c and README

## [3.0.5](https://github.com/GMOD/hclust/compare/v3.0.4...v3.0.5) (2026-04-27)

### Other Changes

- Performance optimizations for hierarchical clustering

- Lance-Williams UPGMA update replaces per-pair member enumeration, making
  distance maintenance O(n) per merge instead of O(cluster_size²)
- Active-index list (swap-with-last removal) replaces flag array so the
  find-minimum loop iterates only live clusters, ~3x fewer comparisons
- Distance matrix computed over upper triangle only and mirrored, halving
  initial pairwise computation
- Linked list tracks leaf order in O(1) per merge, replacing index array copies
- clock() check moved outside inner distance-matrix loop (was called n² times)
- rebuildTree rewritten with stable slot IDs, O(n) with no array splices
- clustersGivenK rebuilt using active Set + membership map for stable slot IDs
- Remove unused dummy Float32Array distances allocation and field from
  ClusterResult
- Add integration tests covering known inputs end-to-end through real WASM
- Replace eslint-plugin-import with eslint-plugin-import-x (modern fork, better
  performance, fewer dependencies) and update lint config
- Update README.md, bump devDependencies, apply formatting

## [3.0.4](https://github.com/GMOD/hclust/compare/v3.0.3...v3.0.4) (2026-03-29)

### Other Changes

- Add clusterObject() API for label-keyed input

- Add clusterObject() that accepts Record<string, number[]> — labels double as
  the object keys instead of a parallel sampleLabels array — and re-exports it
  plus the new ClusterObjectOptions type from the package entry point
- Update README with algorithm description and cancellation docs
- Update tests for new behavior, add clusterObject and roundtrip tests

## [3.0.3](https://github.com/GMOD/hclust/compare/v3.0.2...v3.0.3) (2026-03-29)

### Other Changes

- Halve distance-matrix computation, fix getModule() promise caching, fix
  fromNewick height parsing

- Compute the distance matrix over the upper triangle only and mirror it,
  halving pairwise distance calculations; fix totalDistanceCalcs to
  numSamples \* (numSamples - 1) so progress reporting matches the actual (now
  off-diagonal-only) work
- Cache getModule()'s WASM-init promise instead of its resolved value, and clear
  the cache on rejection — a failed first call no longer wedges every later
  clusterData() call into rethrowing the same rejected promise
- Fix fromNewick parsing a numeric token immediately after ')' as the node's
  height instead of its name
- Add numSamples < 2 guard in hierarchicalClusterWasm to prevent WASM memory
  corruption on degenerate input
- Simplify flatData initialization with Float32Array.set
- Remove the C-side clock()-interval cancellation checks from
  hierarchicalCluster's loops (cancellation is handled by the JS-side
  checkCancellation callback since v2.0.1) and the now-dead
  Cluster.leftChild/rightChild struct fields
- Add -msimd128 to the Emscripten build flags for WASM SIMD vectorization
- Update README algorithm section to describe the current Lance-Williams/ UPGMA
  C implementation (was still describing the original pure-JS version)

## [3.0.2](https://github.com/GMOD/hclust/compare/v3.0.1...v3.0.2) (2026-03-29)

No code changes — republish after a failed publish attempt.

## [3.0.1](https://github.com/GMOD/hclust/compare/v3.0.0...v3.0.1) (2026-03-29)

### Other Changes

- Install Emscripten (mymindstorm/setup-emsdk) in the publish workflow so
  `pnpm build` can compile the WASM module before `npm publish`; source
  `$EMSDK/emsdk_env.sh` (falling back to `~/emsdk`) instead of hardcoding the
  emsdk path in scripts/build_wasm.sh

## [3.0.0](https://github.com/GMOD/hclust/compare/v2.0.1...v3.0.0) (2026-03-29)

### Other Changes

- Make checkCancellation return void (throws on cancel) (#1)

`checkCancellation` changes from `() => boolean` to `() => void`; instead of
returning true to cancel, the callback is expected to throw. The WASM
progress-callback shim no longer inspects a return value to decide whether to
abort the C loop.

- Add a GitHub Actions publish workflow (npm trusted publishing/provenance)
- Add CONTRIBUTING.md
- Simplify CI: drop the Node version matrix

## [2.0.1](https://github.com/GMOD/hclust/compare/v1.0.7...v2.0.1) (2026-03-19)

_(v2.0.0 was tagged from a commit later rewritten out of this branch's history,
so it has no separate entry here — its changes are the same ones listed below.)_

### Other Changes

- Add a `checkCancellation` callback option to `clusterData`/`ClusterOptions`,
  falling back to the legacy `stopToken`-based synchronous-XHR check when no
  callback is given
- Remove the legacy `stopToken`/XHR cancellation path entirely —
  `checkCancellation` is now the only way to cancel a running cluster; drop the
  now-unused `stopToken.ts` module and its web-worker XHR polling

## [1.0.7](https://github.com/GMOD/hclust/compare/v1.0.6...v1.0.7) (2025-11-22)

### Other Changes

- Strip the `import.meta.url` script-name reference from the compiled Emscripten
  output (`sed` to `""` post-build) so the inlined-WASM bundle doesn't depend on
  `import.meta` at runtime

## [1.0.6](https://github.com/GMOD/hclust/compare/v1.0.5...v1.0.6) (2025-11-21)

### Other Changes

- Rename the cancellation error message from "Clustering cancelled" to "aborted"

## [1.0.5](https://github.com/GMOD/hclust/compare/v1.0.4...v1.0.5) (2025-11-21)

### Other Changes

- Export `fromNewick` from the package entry point (was internal-only)

## [1.0.4](https://github.com/GMOD/hclust/compare/v1.0.3...v1.0.4) (2025-11-21)

### Other Changes

- Add `fromNewick()` to parse a Newick-format string back into a `ClusterNode`
  tree, filling in default name/height for nodes that omit them — the read-side
  counterpart to the existing `toNewick()`

## [1.0.3](https://github.com/GMOD/hclust/compare/v1.0.2...v1.0.3) (2025-11-21)

### Other Changes

- Remove source maps from the tsconfig build output

## [1.0.2](https://github.com/GMOD/hclust/compare/v1.0.1...v1.0.2) (2025-11-21)

### Other Changes

- Add `allowJs` to tsconfig.json so the compiled WASM wrapper `.js` is picked up
  by tsc (type-checked and emitted to `dist`/`esm`) instead of being invisible
  to the build

## [1.0.1](https://github.com/GMOD/hclust/compare/v1.0.0...v1.0.1) (2025-11-21)

### Other Changes

- Remove the redundant `coverage` npm script (`vitest run --coverage`)

## [1.0.0](https://github.com/GMOD/hclust/compare/...v1.0.0) (2025-11-21)

### Other Changes

- Extract the clustering package from the `jbrowse-components` monorepo
  (`packages/clustering`) into the standalone `GMOD/hclust` repo: `clusterData`,
  Newick/tree utilities, the Emscripten-compiled UPGMA C core, and
  `stopToken`-based cancellation
- Point `repository`/drop the monorepo `bugs` URL at `GMOD/hclust`, replace the
  tsconfig's `extends` of the monorepo config with a self-contained one, add a
  flat ESLint config (typescript-eslint strict + import plugin), and drop the
  jbrowse-components-specific `example.js`
- Switch the test runner from the monorepo's Jest to vitest; add unit tests for
  `cluster.ts`, `stopToken.ts`, `tree-utils.ts`, and `wasm-wrapper.ts`
- Add a CI GitHub Actions workflow; move test files from `src/` to `test/`
- Add `preversion`/`postversion` npm lifecycle scripts (lint + test + build,
  then `git push --follow-tags`); simplify the CI workflow and tsconfig
