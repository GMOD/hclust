import { describe, expect, it } from 'vitest'

import {
  fromNewick,
  printTree,
  quoteName,
  toNewick,
  treeToJSON,
} from '../src/tree-utils.ts'

import type { ClusterNode } from '../src/types.ts'

describe('tree-utils', () => {
  describe('printTree', () => {
    it('should print a leaf node', () => {
      const node: ClusterNode = {
        name: 'Sample 0',
        height: 0,
      }

      const output = printTree(node)
      expect(output).toBe('└── Sample 0 h=0.00\n')
    })

    it('should print a simple tree with two children', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 1.5,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      }

      const output = printTree(node)
      expect(output).toContain('└── Root h=1.50')
      expect(output).toContain('├── Sample 0 h=0.00')
      expect(output).toContain('└── Sample 1 h=0.00')
    })

    it('should print a nested tree with proper indentation', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 2.0,
        children: [
          {
            name: 'Cluster 0',
            height: 1.0,
            children: [
              { name: 'Sample 0', height: 0 },
              { name: 'Sample 1', height: 0 },
            ],
          },
          { name: 'Sample 2', height: 0 },
        ],
      }

      const output = printTree(node)
      expect(output).toContain('└── Root h=2.00')
      expect(output).toContain('├── Cluster 0 h=1.00')
      expect(output).toContain('│   ├── Sample 0 h=0.00')
      expect(output).toContain('│   └── Sample 1 h=0.00')
      expect(output).toContain('└── Sample 2 h=0.00')
    })

    it('should handle custom indent', () => {
      const node: ClusterNode = {
        name: 'Sample 0',
        height: 0,
      }

      const output = printTree(node, '  ', true)
      expect(output).toBe('  └── Sample 0 h=0.00\n')
    })
  })

  describe('toNewick', () => {
    it('should convert a leaf node to Newick format', () => {
      const node: ClusterNode = {
        name: 'Sample 0',
        height: 0,
      }

      const newick = toNewick(node)
      expect(newick).toBe('Sample 0')
    })

    it('should convert a simple tree to Newick format', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 1.5,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      }

      const newick = toNewick(node)
      expect(newick).toBe('(Sample 0:1.5000,Sample 1:1.5000)')
    })

    it('should convert a nested tree to Newick format', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 2.0,
        children: [
          {
            name: 'Cluster 0',
            height: 1.0,
            children: [
              { name: 'A', height: 0 },
              { name: 'B', height: 0 },
            ],
          },
          { name: 'C', height: 0 },
        ],
      }

      const newick = toNewick(node)
      expect(newick).toBe('((A:1.0000,B:1.0000):1.0000,C:2.0000)')
    })

    it('should handle multiple levels of nesting', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 3.0,
        children: [
          {
            name: 'Cluster 1',
            height: 2.0,
            children: [
              {
                name: 'Cluster 0',
                height: 1.0,
                children: [
                  { name: 'A', height: 0 },
                  { name: 'B', height: 0 },
                ],
              },
              { name: 'C', height: 0 },
            ],
          },
          { name: 'D', height: 0 },
        ],
      }

      const newick = toNewick(node)
      expect(newick).toBe(
        '(((A:1.0000,B:1.0000):1.0000,C:2.0000):1.0000,D:3.0000)',
      )
    })

    it('should format height to 4 decimal places', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 1.23456789,
        children: [
          { name: 'A', height: 0 },
          { name: 'B', height: 0 },
        ],
      }

      const newick = toNewick(node)
      expect(newick).toBe('(A:1.2346,B:1.2346)')
    })
  })

  describe('fromNewick', () => {
    it('should parse a simple leaf node', () => {
      const newick = 'A;'
      const tree = fromNewick(newick)
      expect(tree).toEqual({
        name: 'A',
        height: 0,
      })
    })

    it('should parse a simple tree with two leaves', () => {
      const newick = '(A,B);'
      const tree = fromNewick(newick)
      expect(tree.children).toHaveLength(2)
      expect(tree.children?.[0]).toEqual({ name: 'A', height: 0 })
      expect(tree.children?.[1]).toEqual({ name: 'B', height: 0 })
    })

    it('reads branch lengths as heights back from the deepest leaf', () => {
      const newick = '(A:0.1,B:0.2);'
      const tree = fromNewick(newick)
      expect(tree.height).toBe(0.2)
      expect(tree.children?.[0]?.height).toBeCloseTo(0.1)
      expect(tree.children?.[1]?.height).toBe(0)
    })

    it('should parse nested structure', () => {
      const newick = '((A,B),C);'
      const tree = fromNewick(newick)
      expect(tree.children).toHaveLength(2)
      expect(tree.children?.[0]?.children).toHaveLength(2)
      expect(tree.children?.[0]?.children?.[0]?.name).toBe('A')
      expect(tree.children?.[0]?.children?.[1]?.name).toBe('B')
      expect(tree.children?.[1]?.name).toBe('C')
    })

    it('should parse internal node names', () => {
      // a phylogeny, not a dendrogram: `:` present, so the heights come back
      // from the deepest leaf even though no leaf carries a length of its own
      const newick = '((A,B)E:0.5,C);'
      const tree = fromNewick(newick)
      expect(tree.children?.[0]?.name).toBe('E')
      expect(tree.height).toBe(0.5)
      expect(tree.children?.[0]?.height).toBe(0)
    })

    it('should round-trip with toNewick preserving heights', () => {
      const original: ClusterNode = {
        name: '',
        height: 2.0,
        children: [
          {
            name: '',
            height: 1.0,
            children: [
              { name: 'A', height: 0 },
              { name: 'B', height: 0 },
            ],
          },
          { name: 'C', height: 0 },
        ],
      }

      const newick = toNewick(original)
      const parsed = fromNewick(newick)
      expect(parsed.height).toBeCloseTo(2.0)
      expect(parsed.children?.[0]?.height).toBeCloseTo(1.0)
      expect(parsed.children?.[0]?.children?.[0]?.name).toBe('A')
      expect(parsed.children?.[0]?.children?.[1]?.name).toBe('B')
      expect(parsed.children?.[1]?.name).toBe('C')
    })

    it('should parse numeric height after closing paren', () => {
      const tree = fromNewick('(A,B)1.5000')
      expect(tree.height).toBeCloseTo(1.5)
      expect(tree.children?.[0]?.name).toBe('A')
      expect(tree.children?.[1]?.name).toBe('B')
    })

    it('should handle complex Wikipedia example', () => {
      // D is the deepest tip at 0.5 + 0.4, so that is the root's height and
      // every other node's is what remains of it below them
      const newick = '(A:0.1,B:0.2,(C:0.3,D:0.4)E:0.5)F;'
      const tree = fromNewick(newick)
      expect(tree.name).toBe('F')
      expect(tree.height).toBeCloseTo(0.9)
      expect(tree.children).toHaveLength(3)
      expect(tree.children?.[0]?.height).toBeCloseTo(0.8)
      expect(tree.children?.[1]?.height).toBeCloseTo(0.7)
      expect(tree.children?.[2]?.name).toBe('E')
      expect(tree.children?.[2]?.height).toBeCloseTo(0.4)
      expect(tree.children?.[2]?.children?.[0]?.height).toBeCloseTo(0.1)
      expect(tree.children?.[2]?.children?.[1]?.height).toBe(0)
    })
  })

  describe('the pre-v5 label form', () => {
    // toNewick wrote the merge height as the internal node's label until v5.
    // Saved sessions and stored trees still hold those strings.
    it('reads a height written as a post-paren label', () => {
      const tree = fromNewick('((A,B)1.0000,C)2.0000')
      expect(tree.height).toBeCloseTo(2)
      expect(tree.children?.[0]?.height).toBeCloseTo(1)
      expect(tree.children?.[0]?.children?.[0]).toEqual({
        name: 'A',
        height: 0,
      })
      expect(tree.children?.[1]).toEqual({ name: 'C', height: 0 })
    })

    it('gives both forms of the same tree the same heights', () => {
      const legacy = fromNewick('((A,B)1.0000,C)2.0000')
      const current = fromNewick('((A:1.0000,B:1.0000):1.0000,C:2.0000)')
      expect(current).toEqual(legacy)
    })

    it('leaves a phylogeny bootstrap value as a name, not a height', () => {
      // `:` present, so 95 and 80 stay names and the clades take their heights
      // from the branch lengths below them
      const tree = fromNewick('((A:1,B:1)95,(C:1,D:1)80);')
      expect(tree.children?.[0]?.name).toBe('95')
      expect(tree.children?.[0]?.height).toBe(1)
      expect(tree.children?.[0]?.children?.[0]?.height).toBe(0)
    })
  })

  describe('branch lengths', () => {
    it('writes what every other newick reader expects', () => {
      // a numeric internal *label* is a bootstrap support value to iTOL,
      // FigTree, MEGA and RAxML, so heights must travel as `:` lengths
      const newick = toNewick({
        name: '',
        height: 2,
        children: [
          {
            name: '',
            height: 1,
            children: [
              { name: 'A', height: 0 },
              { name: 'B', height: 0 },
            ],
          },
          { name: 'C', height: 0 },
        ],
      })
      expect(newick).toBe('((A:1.0000,B:1.0000):1.0000,C:2.0000)')
      expect(newick).not.toMatch(/\)\d/)
    })

    it('does not drift over a deep tree', () => {
      // lengths are differences of rounded heights, so they telescope exactly.
      // Differencing the raw heights instead loses a rounding error per level,
      // which over thousands of levels is not small.
      let node: ClusterNode = { name: 'leaf', height: 0 }
      for (let i = 1; i <= 2000; i++) {
        node = {
          name: '',
          height: i / 3,
          children: [node, { name: `S${i}`, height: 0 }],
        }
      }
      const round = fromNewick(toNewick(node))
      expect(round.height).toBeCloseTo(2000 / 3, 4)

      let deepest = round
      while (deepest.children) {
        deepest = deepest.children[0]!
      }
      expect(deepest.name).toBe('leaf')
      expect(deepest.height).toBe(0)
    })
  })

  describe('treeToJSON', () => {
    it('should convert a leaf node to JSON', () => {
      const node: ClusterNode = {
        name: 'Sample 0',
        height: 0,
      }

      const json = treeToJSON(node)
      expect(json).toEqual({
        name: 'Sample 0',
        height: 0,
      })
    })

    it('should convert a simple tree to JSON', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 1.5,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      }

      const json = treeToJSON(node)
      expect(json).toEqual({
        name: 'Root',
        height: 1.5,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      })
    })

    it('should convert a nested tree to JSON', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 2.0,
        children: [
          {
            name: 'Cluster 0',
            height: 1.0,
            children: [
              { name: 'A', height: 0 },
              { name: 'B', height: 0 },
            ],
          },
          { name: 'C', height: 0 },
        ],
      }

      const json = treeToJSON(node)
      expect(json).toEqual({
        name: 'Root',
        height: 2.0,
        children: [
          {
            name: 'Cluster 0',
            height: 1.0,
            children: [
              { name: 'A', height: 0 },
              { name: 'B', height: 0 },
            ],
          },
          { name: 'C', height: 0 },
        ],
      })
    })

    it('should preserve height precision', () => {
      const node: ClusterNode = {
        name: 'Root',
        height: 1.23456789,
        children: [
          { name: 'A', height: 0.987654321 },
          { name: 'B', height: 0 },
        ],
      }

      const json = treeToJSON(node)
      expect(json.height).toBe(1.23456789)
      expect(json.children?.[0]?.height).toBe(0.987654321)
    })

    it('should not include children property for leaf nodes', () => {
      const node: ClusterNode = {
        name: 'Leaf',
        height: 0,
      }

      const json = treeToJSON(node)
      expect(json).not.toHaveProperty('children')
    })

    it('should handle empty children array', () => {
      const node: ClusterNode = {
        name: 'Node',
        height: 1.0,
        children: [],
      }

      const json = treeToJSON(node)
      expect(json).not.toHaveProperty('children')
    })
  })

  describe('quoting', () => {
    function leafNames(node: ClusterNode): string[] {
      return node.children?.length
        ? node.children.flatMap(leafNames)
        : [node.name]
    }

    function roundTrip(names: string[]): string[] {
      const tree: ClusterNode = {
        name: '',
        height: 1.5,
        children: names.map(name => ({ name, height: 0 })),
      }
      return leafNames(fromNewick(toNewick(tree)))
    }

    it('leaves a name with no reserved character alone', () => {
      expect(quoteName('Sample 0')).toBe('Sample 0')
      expect(quoteName('GM12878')).toBe('GM12878')
      expect(quoteName('E003-H1_Cell_Line')).toBe('E003-H1_Cell_Line')
    })

    it('quotes a name with a reserved character, doubling literal quotes', () => {
      expect(quoteName('T cells (CD4+)')).toBe("'T cells (CD4+)'")
      expect(quoteName('has, a comma')).toBe("'has, a comma'")
      expect(quoteName('chr1:100-200')).toBe("'chr1:100-200'")
      expect(quoteName("o'brien")).toBe("'o''brien'")
    })

    // Written bare, the parenthesis is grammar: the label parsed back as an
    // internal node wrapping a leaf called `CD4+`, so a caller checking that
    // the tree's leaves are the rows it clustered saw a tree describing
    // something else.
    it('round-trips a parenthesised name as one leaf', () => {
      expect(roundTrip(['A', 'T cells (CD4+)', 'B'])).toEqual([
        'A',
        'T cells (CD4+)',
        'B',
      ])
    })

    // Worse than the parenthesis case: the comma splits one leaf into two, so
    // the tree comes back the wrong SHAPE and every later leaf is shifted onto
    // its neighbour's name.
    it('round-trips a name containing a comma as one leaf', () => {
      expect(roundTrip(['A', 'has, a comma', 'B'])).toEqual([
        'A',
        'has, a comma',
        'B',
      ])
    })

    it('round-trips names containing colons, semicolons and quotes', () => {
      const names = ['chr1:100-200', 'ends; here', "o'brien", 'plain']
      expect(roundTrip(names)).toEqual(names)
    })

    it('keeps a bare space unquoted and still reads it as one name', () => {
      const newick = toNewick({
        name: '',
        height: 1.5,
        children: [
          { name: 'Sample 0', height: 0 },
          { name: 'Sample 1', height: 0 },
        ],
      })
      expect(newick).toBe('(Sample 0:1.5000,Sample 1:1.5000)')
      expect(roundTrip(['Sample 0', 'Sample 1'])).toEqual([
        'Sample 0',
        'Sample 1',
      ])
    })

    it('treats a quoted post-paren token as a name, not a height', () => {
      const tree = fromNewick("(A,B)'1.5';")
      expect(tree.name).toBe('1.5')
      expect(tree.height).toBe(0)
    })

    it('drops layout whitespace around a quoted label', () => {
      const tree = fromNewick("(\n  'A B' ,\n  'C D'\n)1.5;")
      expect(tree.children?.[0]?.name).toBe('A B')
      expect(tree.children?.[1]?.name).toBe('C D')
      expect(tree.height).toBeCloseTo(1.5)
    })
  })
})

// Single-linkage clustering chains, so clustering N samples can produce a tree
// nearly N deep. Every one of these recursed and threw
// "RangeError: Maximum call stack size exceeded" past about 5000 -- on this
// library's own output, through its own serializer. 10k clears that comfortably
// while staying fast; the string work is quadratic in depth, so 50k takes 12s.
describe('deep trees', () => {
  function chain(n: number): ClusterNode {
    let t: ClusterNode = { name: 'l0', height: 0 }
    for (let i = 1; i < n; i++) {
      t = { name: '', height: i, children: [t, { name: `l${i}`, height: 0 }] }
    }
    return t
  }

  it('serializes and reads back a 10,000-deep dendrogram', () => {
    const tree = chain(10_000)
    const newick = toNewick(tree)
    expect(treeToJSON(tree)).toBeTruthy()

    let depth = 0
    let node = fromNewick(newick)
    while (node.children) {
      depth++
      node = node.children[0]!
    }
    expect(depth).toBe(9_999)
  })
})
