// Clusters real genotypes, the way JBrowse's "Cluster by genotype" does, and
// reports the first call in a fresh process separately from a warm one.
//
// JBrowse hands over one column per variant site in the window, and a 1000
// Genomes window at the default filters is thousands to tens of thousands
// wide, where the distance build is nearly the whole run. The first call
// matters because V8 promotes a wasm function out of its baseline tier on call
// count, without on-stack replacement, and the first clustering in a worker is
// the one the user is waiting on.
//
// Usage: pnpm bench:real [vcf.gz] [--dump=<dir>]
//
// --dump writes each case's matrix to <dir>/<case>.bin so another
// implementation of the distance build can be timed on the identical input.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cases, defaultVcf, loadMatrix, writeMatrix } from './real-matrices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vcf =
  process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? defaultVcf

const dumpArg = process.argv.find(a => a.startsWith('--dump='))
const dumpDir = dumpArg?.slice('--dump='.length)

async function timed(data) {
  const { clusterData } = await import(join(root, 'src/index.ts'))
  const t0 = performance.now()
  await clusterData({ data, onProgress: () => {} })
  return performance.now() - t0
}

const caseArg = process.argv.find(a => a.startsWith('--case='))
if (caseArg) {
  const index = Number(caseArg.slice('--case='.length))
  const c = cases[index]
  const data = loadMatrix(index, vcf)
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true })
    writeMatrix(
      data,
      join(
        dumpDir,
        `${c.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.bin`,
      ),
    )
  }
  const first = await timed(data)
  const warm = await timed(data)
  console.log(
    `| ${c.label} | ${data.length} × ${data[0].length} | ${(first / 1000).toFixed(2)} s | ${(warm / 1000).toFixed(2)} s |`,
  )
} else {
  console.log('| Case | N × V | first call | warm |')
  console.log('| --- | --- | ---: | ---: |')
  cases.forEach((_, i) => {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        vcf,
        `--case=${i}`,
        ...(dumpDir ? [`--dump=${dumpDir}`] : []),
      ],
      {
        stdio: 'inherit',
        maxBuffer: 1 << 30,
      },
    )
  })
}
