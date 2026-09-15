// Reproduces the end-to-end table in docs/optimizations.md: greenelab/hclust
// from npm against this package's shipped wasm, on the real genotype matrices
// bench:real clusters.
//
// Each implementation runs each case once, in its own fresh process, so both
// are first calls and neither inherits the other's garbage. greenelab takes
// minutes per case and over a quarter of an hour on the 5008-row ones; pass
// case indices (see scripts/real-matrices.mjs) to run a subset.
//
// greenelab installs into a gitignored build/ rather than becoming a
// devDependency — nothing but this script wants a 2020 clustering library in
// every checkout.
//
// Usage: pnpm bench:greenelab [case index ...]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { cases, loadMatrix } from './real-matrices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'build', 'greenelab')
const bundle = join(dir, 'node_modules/@greenelab/hclust/build/hclust.min.js')
const self = fileURLToPath(import.meta.url)

const runArg = process.argv.find(a => a.startsWith('--run='))
if (runArg) {
  const [impl, index] = runArg.slice('--run='.length).split(':')
  const data = loadMatrix(Number(index))
  const { clusterData } = await import(
    impl === 'greenelab'
      ? pathToFileURL(bundle).href
      : join(root, 'src/index.ts')
  )
  const input = impl === 'greenelab' ? data.map(row => Array.from(row)) : data
  const t0 = performance.now()
  await clusterData({ data: input, onProgress: () => {} })
  console.log(
    JSON.stringify({
      n: data.length,
      v: data[0].length,
      ms: performance.now() - t0,
    }),
  )
} else {
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

  const run = (impl, index) =>
    JSON.parse(
      execFileSync(process.execPath, [self, `--run=${impl}:${index}`], {
        encoding: 'utf8',
        maxBuffer: 1 << 30,
      }),
    )
  const fmt = ms => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`

  console.log('| Case | N × V | greenelab | current | speedup |')
  console.log('| --- | --- | ---: | ---: | ---: |')
  const indices = process.argv.slice(2).map(Number)
  for (const i of indices.length ? indices : cases.map((_, i) => i)) {
    const before = run('greenelab', i)
    const after = run('current', i)
    console.log(
      `| ${cases[i].label} | ${after.n} × ${after.v} | ${fmt(before.ms)} | ${fmt(after.ms)} | ${Math.round(before.ms / after.ms)}× |`,
    )
  }
}
