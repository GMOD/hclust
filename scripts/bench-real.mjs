// Clusters real genotypes, the way JBrowse's "Cluster by genotype" does, and
// reports the first call in a fresh process separately from a warm one.
//
// Every other benchmark here uses V = 20 columns, where the merge loop is the
// cost. JBrowse hands over one column per variant site in the window, and a
// 1000 Genomes window at the default filters is thousands to tens of
// thousands wide, where the distance build is nearly the whole run. The first
// call matters because V8 promotes a wasm function out of its baseline tier on
// call count, without on-stack replacement, and the first clustering in a
// worker is the one the user is waiting on.
//
// The bundled data is 1000 Genomes phase 3, chr22:20,000,000-21,000,000, 2504
// samples, 22,383 phased sites (`tabix -h <phase3 chr22 URL> 22:20000000-21000000`).
// Matrices follow plugins/variants in jbrowse-components: one column per ALT
// allele, dosage scaled to 2/called, a no-call as NaN imputed to the site
// mean; phased mode is one 0/1 row per haplotype.
//
// Usage: pnpm bench:real [vcf.gz]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vcf =
  process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ??
  join(root, 'benchmarks/data/1kg_chr22_20-21Mb.vcf.gz')

const cases = [
  {
    label: '100 kb window, MAF 0, samples',
    bp: 100_000,
    maf: 0,
    phased: false,
  },
  {
    label: '100 kb window, MAF 0, haplotypes',
    bp: 100_000,
    maf: 0,
    phased: true,
  },
  {
    label: '1 Mb window, MAF 0.05, samples',
    bp: Infinity,
    maf: 0.05,
    phased: false,
  },
  {
    label: '1 Mb window, MAF 0.05, haplotypes',
    bp: Infinity,
    maf: 0.05,
    phased: true,
  },
  { label: '1 Mb window, MAF 0, samples', bp: Infinity, maf: 0, phased: false },
  {
    label: '1 Mb window, MAF 0, haplotypes',
    bp: Infinity,
    maf: 0,
    phased: true,
  },
]

function readSites(text) {
  const sites = []
  let numSamples = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('##') || line === '') {
      continue
    }
    const f = line.split('\t')
    if (line.startsWith('#')) {
      numSamples = f.length - 9
      continue
    }
    const gtIndex = f[8].split(':').indexOf('GT')
    sites.push({
      pos: Number(f[1]),
      numAlts: f[4].split(',').length,
      gts: f.slice(9).map(s => s.split(':')[gtIndex]),
    })
  }
  return { sites, numSamples }
}

function minorAlleleFrequency(gts) {
  const counts = new Map()
  for (const gt of gts) {
    for (const a of gt.split(/[/|]/)) {
      counts.set(a, (counts.get(a) ?? 0) + 1)
    }
  }
  let first = 0
  let second = 0
  let called = 0
  for (const [allele, c] of counts) {
    if (allele !== '.') {
      called += c
      if (c > first) {
        second = first
        first = c
      } else if (c > second) {
        second = c
      }
    }
  }
  return called > 0 ? second / called : 0
}

function dosageColumns(site, numSamples) {
  return Array.from({ length: site.numAlts }, (_, alt) => {
    const col = new Float32Array(numSamples)
    site.gts.forEach((gt, s) => {
      let called = 0
      let d = 0
      for (const a of gt.split(/[/|]/)) {
        if (a !== '.') {
          called++
          if (Number(a) === alt + 1) {
            d++
          }
        }
      }
      col[s] = called === 0 ? NaN : d * (2 / called)
    })
    return col
  })
}

function haplotypeColumn(site, numSamples) {
  const col = new Float32Array(numSamples * 2)
  site.gts.forEach((gt, s) => {
    const alleles = gt.split('|')
    for (let h = 0; h < 2; h++) {
      const a = alleles.length === 2 ? alleles[h] : '.'
      col[2 * s + h] = a === '.' ? NaN : a === '0' ? 0 : 1
    }
  })
  return col
}

// A tabix region query also returns the records that overlap its start, so
// the first site can sit before the window; the window starts at the first
// 100 kb boundary at or after it, 20,000,000 for the bundled slice.
function buildMatrix({ bp, maf, phased }, { sites, numSamples }) {
  const start = Math.ceil(sites[0].pos / 100_000) * 100_000
  const columns = []
  for (const site of sites) {
    if (
      site.pos >= start &&
      site.pos - start < bp &&
      minorAlleleFrequency(site.gts) >= maf
    ) {
      columns.push(
        ...(phased
          ? [haplotypeColumn(site, numSamples)]
          : dosageColumns(site, numSamples)),
      )
    }
  }
  const rows = phased ? numSamples * 2 : numSamples
  const data = Array.from(
    { length: rows },
    () => new Float32Array(columns.length),
  )
  columns.forEach((col, c) => {
    let sum = 0
    let n = 0
    for (let r = 0; r < rows; r++) {
      if (!Number.isNaN(col[r])) {
        sum += col[r]
        n++
      }
    }
    const mean = n === 0 ? 0 : sum / n
    for (let r = 0; r < rows; r++) {
      data[r][c] = Number.isNaN(col[r]) ? mean : col[r]
    }
  })
  return data
}

async function timed(data) {
  const { clusterData } = await import(join(root, 'src/index.ts'))
  const t0 = performance.now()
  await clusterData({ data, onProgress: () => {} })
  return performance.now() - t0
}

const caseArg = process.argv.find(a => a.startsWith('--case='))
if (caseArg) {
  const c = cases[Number(caseArg.slice('--case='.length))]
  const data = buildMatrix(
    c,
    readSites(gunzipSync(readFileSync(vcf)).toString()),
  )
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
      [fileURLToPath(import.meta.url), vcf, `--case=${i}`],
      {
        stdio: 'inherit',
        maxBuffer: 1 << 30,
      },
    )
  })
}
