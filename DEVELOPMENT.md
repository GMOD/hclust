# Development Guide for @gmod/hclust

## Architecture

This package uses a hybrid approach:

- **WASM (C)**: Distance matrix computation (40-72% faster than JS)
- **TypeScript**: Tree building, cluster merging, output formatting

### Why This Split?

**WASM handles:**

- ✅ `euclideanDistance()` - Tight numeric loops
- ✅ `computeDistanceMatrix()` - O(n²) computation bottleneck
- ✅ `averageDistance()` - Called many times during clustering

**JavaScript/TypeScript handles:**

- ✅ Tree structure manipulation (dynamic objects/arrays)
- ✅ Cluster merging logic
- ✅ Output formatting (Newick, JSON, text)
- ✅ Progress tracking and cancellation

## Performance Benchmarks

From a one-off comparison against the pure-JS implementation:

| Samples | JS Baseline | WASM f32 | Improvement |
| ------- | ----------- | -------- | ----------- |
| 50      | 31.64ms     | 17.30ms  | 45.33%      |
| 100     | 30.23ms     | 16.74ms  | 44.61%      |
| 200     | 14.87ms     | 4.13ms   | **72.24%**  |
| 500     | 14.11ms     | 6.29ms   | 55.46%      |
| 1000    | 18.21ms     | 10.91ms  | 40.11%      |

## Building

### Prerequisites

Emscripten SDK must be installed and activated:

```bash
cd ~/emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

`build:wasm` sources `emsdk_env.sh` itself, from `$EMSDK` or `~/emsdk`, so
`emcc` does not need to be on your PATH.

### Build Commands

```bash
# Build WASM module only
pnpm build:wasm

# Build entire package (WASM + TypeScript)
pnpm build

# Clean build artifacts
pnpm clean
```

A rebuild must reproduce the tracked `src/wasm/distance.js` byte for byte —
`preversion` runs `pnpm build`, so a bundle that differs would be committed
part-way through a release. Check with `pnpm build:wasm && git status`.

## File Structure

```
src/
├── wasm/
│   ├── distance.c          # C source for WASM
│   ├── distance.js         # Emscripten output, WASM inlined as base64 (tracked)
│   └── distance.d.ts       # Hand-written types for the bundle above
├── wasm-wrapper.ts         # TypeScript wrapper for WASM
├── cluster.ts              # Main clustering algorithm
├── tree-utils.ts           # Tree output formatting
├── types.ts                # TypeScript type definitions
└── index.ts                # Package exports
scripts/
├── build_wasm.sh           # WASM build script
└── regen-v304-snapshots.ts # Regenerates the v3.0.4 comparison fixtures
```

`distance.js` is tracked in git so that installing the package needs no
emscripten. There is no separate `.wasm` file — `SINGLE_FILE=1` inlines it.

## C Code Optimizations

The C code includes several optimizations:

1. **Loop unrolling** - `euclideanDistance()` unrolls by 4
2. **Float32** - Uses `float` instead of `double` for better cache usage
3. **Const pointers** - Allows compiler optimizations
4. **Inlined operations** - No function call overhead in tight loops

## Emscripten Compiler Flags

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

## Future Optimizations

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
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --run && pnpm build
```

Some tests compare against fixtures captured from v3.0.4. If the output format
changes deliberately, regenerate them — `scripts/regen-v304-snapshots.ts`
carries the three commands at the top of the file.
