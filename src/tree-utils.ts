import { parseNewick } from '@gmod/newick'

import type { ClusterNode } from './types.ts'
import type { NewickNode } from '@gmod/newick'

// Iterative for the same reason toNewick is. The stack carries each node's own
// prefix, since it depends on the whole chain of ancestors above it.
export function printTree(
  node: ClusterNode,
  indent = '',
  isLast = true,
): string {
  let output = ''
  const stack = [{ node, indent, isLast }]
  while (stack.length > 0) {
    const frame = stack.pop()!
    const prefix = frame.indent + (frame.isLast ? '└── ' : '├── ')
    output += `${prefix}${frame.node.name} h=${frame.node.height.toFixed(2)}\n`
    const kids = frame.node.children
    if (kids) {
      const childIndent = frame.indent + (frame.isLast ? '    ' : '│   ')
      // reversed, so the leftmost child pops first and the output reads the same
      // as the recursive version's
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({
          node: kids[i]!,
          indent: childIndent,
          isLast: i === kids.length - 1,
        })
      }
    }
  }
  return output
}

// The characters that mean something to the grammar, so a label containing one
// has to be quoted or the string parses back as a different tree.
//
// Whitespace is deliberately NOT in the set. Strict Newick wants a space quoted
// (or written as `_`), but a bare space is ubiquitous in practice and both this
// parser and every one we know of reads it as part of the label, so quoting it
// would rewrite the output of essentially every real dataset ("Sample 0") to fix
// nothing. This set is exactly the characters that were silently corrupting
// trees.
const NEEDS_QUOTING = /[(),:;'[\]]/

/**
 * Quote a node name for Newick output, if it needs it. Newick escapes a literal
 * single quote by doubling it.
 *
 * Exported because a caller that builds its own Newick from `ClusterNode`s needs
 * the same rule, and two implementations of an escaping rule are two chances to
 * disagree with `fromNewick`.
 */
export function quoteName(name: string): string {
  return NEEDS_QUOTING.test(name) ? `'${name.replaceAll("'", "''")}'` : name
}

// Newick format: Olsen (1990) http://evolution.genetics.washington.edu/phylip/newicktree.html
// Note: this library encodes internal node height as the label (e.g. "(A,B)1.2345"),
// not as a branch length (":"). fromNewick handles both forms on input.
//
// Names are quoted on the way out. `clusterObject` takes its labels from the
// keys of the caller's data object, which are arbitrary strings from somebody's
// file: written bare, a name like `T cells (CD4+)` IS grammar, and parses back
// as an internal node wrapping a leaf called `CD4+`. A comma is worse, splitting
// one leaf into two so the tree comes back the wrong shape with every later leaf
// shifted onto its neighbour's name.
export function toNewick(node: ClusterNode): string {
  // Iterative, because a single-linkage dendrogram chains: clustering N samples
  // can produce a tree nearly N deep, and recursing threw
  // "RangeError: Maximum call stack size exceeded" past about 5000 -- on the
  // library's own output, through its main serializer.
  //
  // Post-order (children before parents) so a node's subtrees are already
  // rendered when it is reached.
  const order: ClusterNode[] = []
  const stack = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    order.push(n)
    if (n.children) {
      for (const child of n.children) {
        stack.push(child)
      }
    }
  }

  const rendered = new Map<ClusterNode, string>()
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!
    if (n.children?.length) {
      // drop each child's string as it is folded into the parent. Recursion
      // freed these as it unwound; holding the whole map to the end instead
      // means every intermediate subtree string is live at once, which for a
      // caterpillar is quadratic and ran a 50k-leaf tree out of heap.
      const parts = n.children.map(c => {
        const s = rendered.get(c)!
        rendered.delete(c)
        return s
      })
      rendered.set(n, `(${parts.join(',')})${n.height.toFixed(4)}`)
    } else {
      rendered.set(n, quoteName(n.name))
    }
  }
  return rendered.get(node)!
}

/**
 * Read Newick into a `ClusterNode`.
 *
 * `postParenNumeric: 'length'` because `toNewick` above writes an internal
 * node's merge height as its post-paren label rather than as a `:` branch
 * length, and that number is the whole point of a dendrogram. The parser's
 * default would only read it as a height while the tree carries no `:` anywhere,
 * which is true of what `toNewick` writes but not of a phylogeny somebody hands
 * us.
 */
export function fromNewick(s: string): ClusterNode {
  const parsed = parseNewick(s, { postParenNumeric: 'length' })
  const asCluster = (n: NewickNode): ClusterNode => ({
    name: n.name ?? '',
    height: n.length ?? 0,
  })

  // iterative, like the parser it calls: a single-linkage dendrogram chains, so
  // this tree can be nearly as deep as it has leaves
  const root = asCluster(parsed)
  const stack = [{ source: parsed, target: root }]
  while (stack.length > 0) {
    const { source, target } = stack.pop()!
    if (source.children) {
      target.children = source.children.map(asCluster)
      for (const [i, child] of source.children.entries()) {
        stack.push({ source: child, target: target.children[i]! })
      }
    }
  }
  return root
}

// Iterative for the same reason toNewick is -- the tree it copies can be nearly
// as deep as it has leaves.
export function treeToJSON(node: ClusterNode): ClusterNode {
  const plain = (n: ClusterNode): ClusterNode => ({
    name: n.name,
    height: n.height,
  })
  const root = plain(node)
  const stack = [{ source: node, target: root }]
  while (stack.length > 0) {
    const { source, target } = stack.pop()!
    if (source.children?.length) {
      target.children = source.children.map(plain)
      for (const [i, child] of source.children.entries()) {
        stack.push({ source: child, target: target.children[i]! })
      }
    }
  }
  return root
}
