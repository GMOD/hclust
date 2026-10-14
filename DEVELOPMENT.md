# Development guide for @gmod/hclust

## Architecture

The package splits the work between C compiled to WebAssembly and TypeScript:

- **WASM (C)**: Distance matrix computation (40-72% faster than JS)
- **TypeScript**: Tree building, cluster merging, output formatting

### Why the split?

**WASM handles:**

- `euclideanDistance()` - Tight numeric loops
- `computeDistanceMatrix()` - O(n²) computation bottleneck
- `averageDistance()` - Called many times during clustering

**JavaScript/TypeScript handles:**

- Tree structure manipulation (dynamic objects/arrays)
- Cluster merging logic
- Output formatting (Newick, JSON, text)
- Progress tracking and cancellation

## Performance benchmarks

From a one-off comparison against the pure-JS implementation:

| samples | JS baseline | WASM f32 | improvement |
| ------- | ----------- | -------- | ----------- |
| 50      | 31.64ms     | 17.30ms  | 45.33%      |
| 100     | 30.23ms     | 16.74ms  | 44.61%      |
| 200     | 14.87ms     | 4.13ms   | **72.24%**  |
| 500     | 14.11ms     | 6.29ms   | 55.46%      |
| 1000    | 18.21ms     | 10.91ms  | 40.11%      |

## Building

### Prerequisites

Install and activate the Emscripten SDK at the version in `.emscripten-version`,
which CI also reads:

```bash
~/emsdk/emsdk install $(cat .emscripten-version)
~/emsdk/emsdk activate $(cat .emscripten-version)
```

`build:wasm` sources `emsdk_env.sh` itself, from `$EMSDK` or `~/emsdk`, so
`emcc` does not need to be on your PATH. It refuses to build under any other
emcc version, because a different emscripten emits different JS.

### Build commands

```bash
# Build WASM module only
pnpm build:wasm

# Build entire package (WASM + TypeScript)
pnpm build

# Clean build artifacts
pnpm clean
```

A rebuild must reproduce the tracked `src/wasm/distance.js` byte for byte.
`pnpm check:wasm` fails if `src/wasm` differs from git after a build; CI and
`preversion` run it right after `pnpm build`, so a `distance.c` change can't
land or ship without its regenerated bundle.

## File structure

```
src/
├── wasm/
│   ├── distance.c          # C source for WASM
│   ├── distance.js         # Emscripten output, WASM inlined as base64 (tracked)
│   └── distance.d.ts       # Hand-written types for the bundle above
├── wasm-wrapper.ts         # TypeScript wrapper for WASM: steps a run, yields, aborts
├── yield-task.ts           # The task a run yields to between slices
├── cluster.ts              # Main clustering algorithm
├── tree-utils.ts           # Tree output formatting
├── types.ts                # TypeScript type definitions
└── index.ts                # Package exports
scripts/
├── build_wasm.sh           # WASM build script
├── check-wasm.sh           # Fails if src/wasm differs from a fresh build
└── regen-v304-snapshots.ts # Regenerates the v3.0.4 comparison fixtures
```

Git tracks `distance.js` so that installing the package needs no emscripten.
There is no separate `.wasm` file — `SINGLE_FILE=1` inlines it.

## C code optimizations

The C code includes several optimizations:

1. **Loop unrolling** - `euclideanDistance()` unrolls by 4
2. **Float32** - Uses `float` instead of `double` for better cache usage
3. **Const pointers** - Allows compiler optimizations
4. **Inlined operations** - No function call overhead in tight loops

## Emscripten compiler flags

See `scripts/build_wasm.sh` for the full command. The flags worth knowing:

```bash
  -O3                              # Maximum optimization
  -msimd128                        # SIMD
  -s ALLOW_MEMORY_GROWTH=1         # Dynamic memory
  -s INITIAL_MEMORY=64MB           # Start with 64MB
  -s MAXIMUM_MEMORY=2GB            # Allow up to 2GB
  -s MODULARIZE=1 -s EXPORT_ES6=1  # ES6 module
  -s SINGLE_FILE=1                 # Inline the wasm as base64
  -s ENVIRONMENT='web,worker'      # Not 'node': that init path emits a
                                   # top-level `await import("node:module")`
                                   # webpack 5 cannot resolve, and inlined
                                   # wasm never needs it. Node satisfies the
                                   # `web` path via atob + WebAssembly.
```

## Future optimizations

Potential improvements:

- [ ] SIMD vectorization for distance calculations
- [ ] Parallel distance matrix computation
- [ ] Incremental clustering for very large datasets
- [ ] Additional linkage methods (single, complete, ward)
- [ ] Different distance metrics (Manhattan, cosine, etc.)

## Testing

```bash
# Run tests (watch mode; --run for one pass)
pnpm test

# Everything CI runs, in CI's order
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm check:wasm && pnpm test --run && pnpm test:pack
```

Some tests compare against fixtures captured from v3.0.4. If the output format
changes deliberately, regenerate them with the three commands listed at the top
of `scripts/regen-v304-snapshots.ts`.

## Benchmarking

```bash
# Current build, callback and tied-input regimes included
pnpm bench

# The tables in docs/optimizations.md, all of which regenerate
pnpm bench:generations   # three C generations, compiled from their commits
pnpm bench:greenelab     # the original JS implementation vs the shipped wasm

# Real genotypes at JBrowse's widths, each case in a fresh process so the
# first call is measured separately from a warm one
pnpm bench:real [vcf.gz]
```

`bench:generations`, `bench:greenelab` and `bench:real` read the bundled 1000
Genomes slice in `benchmarks/data/` (2504 samples, 1 Mb of chr22) through
`scripts/real-matrices.mjs`, with no tools beyond node. `bench:generations` also
needs a host `cc`, not emscripten. `bench:greenelab` installs its baseline into
a gitignored `build/` on first run and takes about an hour over every case; pass
case indices to run a subset. `bench:real` takes a couple of minutes.
