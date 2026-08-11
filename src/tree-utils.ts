import type { ClusterNode } from './types.ts'

export function printTree(
  node: ClusterNode,
  indent = '',
  isLast = true,
): string {
  const prefix = indent + (isLast ? '└── ' : '├── ')
  let output = `${prefix}${node.name} h=${node.height.toFixed(2)}\n`

  if (node.children) {
    const newIndent = indent + (isLast ? '    ' : '│   ')
    for (let i = 0; i < node.children.length; i++) {
      const isLastChild = i === node.children.length - 1
      output += printTree(node.children[i]!, newIndent, isLastChild)
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
  if (!node.children || node.children.length === 0) {
    return quoteName(node.name)
  }

  const childStrings = node.children.map(child => toNewick(child))
  return `(${childStrings.join(',')})${node.height.toFixed(4)}`
}

function newNode(): ClusterNode {
  return { name: '', height: 0 }
}

interface Token {
  text: string
  // a bare grammar character, as opposed to label text that happens to equal one
  delim: boolean
  // arrived single-quoted, so it is a label whatever it looks like
  quoted: boolean
}

// Split into grammar characters and labels. A hand-rolled scanner rather than
// the `split(/\s*(;|\(|\)|,|:)\s*/)` this used to be, because a regex split
// cannot know it is inside a quoted label and so splits the label apart on the
// very characters quoting exists to protect.
//
// Whitespace is consumed around the delimiters and kept inside labels, so a bare
// `Sample 0` still reads as one name; inside quotes it is kept verbatim.
function tokenize(s: string): Token[] {
  const out: Token[] = []
  // text since the last delimiter, kept apart so a quoted label can own the
  // token: whitespace written around the quotes is layout in a hand-formatted
  // file, not part of the name
  let bare = ''
  let quotedText = ''
  let quoted = false
  const flush = () => {
    const text = quoted ? quotedText : bare.trim()
    // an empty run between two delimiters is not a label; an explicitly quoted
    // '' is one, so it survives
    if (text !== '' || quoted) {
      out.push({ text, delim: false, quoted })
    }
    bare = ''
    quotedText = ''
    quoted = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "'") {
      quoted = true
      for (i++; i < s.length; i++) {
        if (s[i] !== "'") {
          quotedText += s[i]!
        } else if (s[i + 1] === "'") {
          // '' is an escaped literal quote, not the end of the label
          quotedText += "'"
          i++
        } else {
          break
        }
      }
    } else if (c === '(' || c === ')' || c === ',' || c === ':' || c === ';') {
      flush()
      out.push({ text: c, delim: true, quoted: false })
    } else {
      bare += c
    }
  }
  flush()
  return out
}

export function fromNewick(s: string): ClusterNode {
  const ancestors: ClusterNode[] = []
  let tree = newNode()
  const tokens = tokenize(s)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const subtree = newNode()
    if (token.delim) {
      switch (token.text) {
        case '(':
          tree.children = [subtree]
          ancestors.push(tree)
          tree = subtree
          break
        case ',':
          ancestors.at(-1)?.children?.push(subtree)
          tree = subtree
          break
        case ')':
          tree = ancestors.pop()!
          break
        default:
          // ':' and ';' are consumed by the label that follows them
          break
      }
      continue
    }
    const prev = tokens[i - 1]
    const x = prev?.delim ? prev.text : undefined
    if (x === ')') {
      // A QUOTED token after `)` is a name whatever it looks like: quoting is
      // the writer saying this is a label, and it is the only way to call a
      // node `1.5`.
      const num = token.quoted ? Number.NaN : Number.parseFloat(token.text)
      if (!Number.isNaN(num)) {
        tree.height = num
      } else {
        tree.name = token.text
      }
    } else if (x === '(' || x === ',' || (x === undefined && !prev)) {
      tree.name = token.text
    } else if (x === ':') {
      tree.height = Number.parseFloat(token.text)
    }
  }

  return tree
}

export function treeToJSON(node: ClusterNode): ClusterNode {
  if (!node.children?.length) {
    return { name: node.name, height: node.height }
  }
  return {
    name: node.name,
    height: node.height,
    children: node.children.map(treeToJSON),
  }
}
