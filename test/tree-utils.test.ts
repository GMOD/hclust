import { describe, expect, it } from 'vitest'

import {
  fromNewick,
  printTree,
  quoteName,
  toNewick,
  treeToJSON,
} from '../src/tree-utils.js'

import type { ClusterNode } from '../src/types.js'

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
      expect(newick).toBe('(Sample 0,Sample 1)1.5000')
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
      expect(newick).toBe('((A,B)1.0000,C)2.0000')
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
      expect(newick).toBe('(((A,B)1.0000,C)2.0000,D)3.0000')
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
      expect(newick).toBe('(A,B)1.2346')
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

    it('should parse branch lengths', () => {
      const newick = '(A:0.1,B:0.2);'
      const tree = fromNewick(newick)
      expect(tree.children?.[0]?.height).toBe(0.1)
      expect(tree.children?.[1]?.height).toBe(0.2)
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

    it('should parse internal node names and heights', () => {
      const newick = '((A,B)E:0.5,C);'
      const tree = fromNewick(newick)
      expect(tree.children?.[0]?.name).toBe('E')
      expect(tree.children?.[0]?.height).toBe(0.5)
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
      const newick = '(A:0.1,B:0.2,(C:0.3,D:0.4)E:0.5)F;'
      const tree = fromNewick(newick)
      expect(tree.name).toBe('F')
      expect(tree.children).toHaveLength(3)
      expect(tree.children?.[0]).toEqual({ name: 'A', height: 0.1 })
      expect(tree.children?.[1]).toEqual({ name: 'B', height: 0.2 })
      expect(tree.children?.[2]?.name).toBe('E')
      expect(tree.children?.[2]?.height).toBe(0.5)
      expect(tree.children?.[2]?.children?.[0]).toEqual({
        name: 'C',
        height: 0.3,
      })
      expect(tree.children?.[2]?.children?.[1]).toEqual({
        name: 'D',
        height: 0.4,
      })
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
      expect(newick).toBe('(Sample 0,Sample 1)1.5000')
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
