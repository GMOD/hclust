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

const PRECISION = 4

// Round to what the serializer prints, so branch lengths telescope exactly:
// summing (parent - child) down a path of printed values lands back on the
// printed root height, however deep the tree. Differencing the unrounded
// heights instead accumulates a rounding error per level, which on a 50k-leaf
// caterpillar is not small.
function rounded(height: number) {
  return Number(height.toFixed(PRECISION))
}

// Newick format: Olsen (1990) http://evolution.genetics.washington.edu/phylip/newicktree.html
//
// A `ClusterNode` carries the absolute height its cluster merged at, and this
// writes the differences between those heights as `:` branch lengths, which is
// what every other reader of the format expects. Absolute heights survive it:
// UPGMA is monotonic (`distance.c` clamps the float-rounding inversions), so a
// node's height is the root's minus the lengths on the path down to it, and
// `fromNewick` recovers them that way.
//
// Until v5 this wrote the height into the internal node's *label* instead
// (`(A,B)1.2345`). Every mainstream viewer -- iTOL, FigTree, MEGA, RAxML,
// IQ-TREE, MrBayes -- reads a numeric internal label as a bootstrap support
// value, so those trees loaded as unlengthed cladograms carrying nonsense
// support, and FigTree mapped the labels onto the wrong nodes when rerooting.
// Nothing warned: the string parsed fine everywhere and drew the wrong picture.
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

  // A child's `:length` is written as it folds into its parent, which is the
  // only point both heights are in hand. The root never folds into anything, so
  // it alone carries no length -- correct, since there is no branch above it.
  const rendered = new Map<ClusterNode, string>()
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!
    if (n.children?.length) {
      const height = rounded(n.height)
      // drop each child's string as it is folded into the parent. Recursion
      // freed these as it unwound; holding the whole map to the end instead
      // means every intermediate subtree string is live at once, which for a
      // caterpillar is quadratic and ran a 50k-leaf tree out of heap.
      const parts = n.children.map(c => {
        const s = rendered.get(c)!
        rendered.delete(c)
        return `${s}:${(height - rounded(c.height)).toFixed(PRECISION)}`
      })
      rendered.set(n, `(${parts.join(',')})`)
    } else {
      rendered.set(n, quoteName(n.name))
    }
  }
  return rendered.get(node)!
}

/**
 * Read Newick into a `ClusterNode`, in either encoding of a node's height.
 *
 * What `toNewick` writes, and what a phylogeny carries, is a `:` branch length
 * per node, so a height is the root's minus the lengths down to it. What
 * `toNewick` wrote before v5 -- and what is still sitting in saved sessions --
 * is the absolute height as the internal node's post-paren label, with no `:`
 * anywhere in the string.
 *
 * Reading `postParenNumeric: 'name'` first is what tells the two apart, because
 * under it a `length` can only have come from a `:` token: none anywhere means
 * the string carries no branch lengths, so any post-paren numbers on it are the
 * old form's heights and a second pass reads them as such. Detecting on which
 * nodes carry a length instead would misread `((A,B)E:0.5,C);` -- a phylogeny
 * whose leaves happen to have no lengths of their own.
 */
export function fromNewick(s: string): ClusterNode {
  const parsed = parseNewick(s, { postParenNumeric: 'name' })
  const root: ClusterNode = { name: parsed.name ?? '', height: 0 }

  // iterative, like the parser it calls: a UPGMA dendrogram chains, so this tree
  // can be nearly as deep as it has leaves
  const pairs: { source: NewickNode; target: ClusterNode }[] = []
  const stack = [{ source: parsed, target: root }]
  while (stack.length > 0) {
    const pair = stack.pop()!
    pairs.push(pair)
    const { source, target } = pair
    if (source.children) {
      target.children = source.children.map(n => ({
        name: n.name ?? '',
        height: 0,
      }))
      for (const [i, child] of source.children.entries()) {
        stack.push({ source: child, target: target.children[i]! })
      }
    }
  }

  if (!pairs.some(p => p.source.length !== undefined)) {
    // no `:` anywhere, so re-read with the post-paren numbers as the heights
    // they are in the pre-v5 form. Names are taken from this pass too: in the
    // one above the same token parsed as the node's name, and leaving it there
    // would report every internal node as named for its own height.
    const legacy = parseNewick(s, { postParenNumeric: 'length' })
    const stack = [{ source: legacy, target: root }]
    while (stack.length > 0) {
      const { source, target } = stack.pop()!
      target.name = source.name ?? ''
      target.height = source.length ?? 0
      for (const [i, child] of source.children?.entries() ?? []) {
        stack.push({ source: child, target: target.children![i]! })
      }
    }
    return root
  }

  // Depth from the root, then heights measured back from the deepest leaf. Every
  // leaf of an ultrametric dendrogram sits at the same depth, so the max is the
  // root's height; taking the max rather than any one leaf also gives a sane
  // answer for a phylogeny, whose leaves are ragged.
  const depth = new Map<ClusterNode, number>([[root, parsed.length ?? 0]])
  for (const { source, target } of pairs) {
    const own = depth.get(target)!
    for (const [i, child] of source.children?.entries() ?? []) {
      depth.set(target.children![i]!, own + (child.length ?? 0))
    }
  }
  const deepest = Math.max(...depth.values())
  for (const [node, d] of depth) {
    node.height = deepest - d
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
