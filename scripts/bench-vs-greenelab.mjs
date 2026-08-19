// Reproduces the end-to-end table in docs/optimizations.md: greenelab/hclust
// from npm against this package's shipped wasm, on identical data.
//
// greenelab installs into a gitignored build/ rather than becoming a
// devDependency — nothing but this script wants a 2020 clustering library in
// every checkout.
//
// Usage: pnpm bench:greenelab [N ...]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'build', 'greenelab')
const bundle = join(dir, 'node_modules/@greenelab/hclust/build/hclust.min.js')

if (!existsSync(bundle)) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hclust-baseline', private: true }),
  )
  console.log('installing @greenelab/hclust@0.0.1...')
  execFileSync(
    'npm',
    ['install', '--prefix', dir, '--silent', '@greenelab/hclust@0.0.1'],
    { stdio: 'inherit' },
  )
}

const { clusterData: greenelab } = await import(pathToFileURL(bundle).href)
const { clusterData: current } = await import(join(root, 'src/index.ts'))

const V = 20
const sizes = process.argv.slice(2).map(Number)
const value = (i, j) => Math.sin(i * 31 + j * 7) * 100

async function best(runs, fn) {
  const times = []
  for (let r = 0; r < runs; r++) {
    const t = performance.now()
    await fn()
    times.push(performance.now() - t)
  }
  return Math.min(...times)
}

console.log('greenelab: 1 run. current: best of 3, past the wasm compile.')
console.log()
console.log('| N | greenelab (ms) | current (ms) | speedup |')
console.log('| --- | ---: | ---: | ---: |')

for (const n of sizes.length ? sizes : [250, 500, 1000, 1500, 2000]) {
  const rows = Array.from({ length: n }, (_, i) => i)
  const before = await best(1, () =>
    greenelab({
      data: rows.map(i => Array.from({ length: V }, (_, j) => value(i, j))),
      onProgress: () => {},
    }),
  )
  const after = await best(3, () =>
    current({
      data: rows.map(i =>
        Float32Array.from({ length: V }, (_, j) => value(i, j)),
      ),
    }),
  )
  const fmt = ms =>
    ms >= 1000 ? Math.round(ms).toLocaleString() : ms.toFixed(0)
  console.log(
    `| ${n} | ${fmt(before)} | ${fmt(after)} | ${Math.round(before / after)}x |`,
  )
}
