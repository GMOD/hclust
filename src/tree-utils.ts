import type { ClusterNode } from './types.js'

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

// Newick format: Olsen (1990) http://evolution.genetics.washington.edu/phylip/newicktree.html
// Note: this library encodes internal node height as the label (e.g. "(A,B)1.2345"),
// not as a branch length (":"). fromNewick handles both forms on input.
export function toNewick(node: ClusterNode): string {
  if (!node.children || node.children.length === 0) {
    return node.name
  }

  const childStrings = node.children.map(child => toNewick(child))
  return `(${childStrings.join(',')})${node.height.toFixed(4)}`
}

function newNode(): ClusterNode {
  return { name: '', height: 0 }
}

export function fromNewick(s: string): ClusterNode {
  const ancestors: ClusterNode[] = []
  let tree = newNode()
  const tokens = s.split(/\s*(;|\(|\)|,|:)\s*/)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const subtree = newNode()
    switch (token) {
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
      case ';':
      case ':':
        break
      default: {
        const x = tokens[i - 1]
        if (x === ')') {
          const num = Number.parseFloat(token)
          if (!Number.isNaN(num)) {
            tree.height = num
          } else {
            tree.name = token
          }
        } else if (x === '(' || x === ',' || x === undefined || x === '') {
          tree.name = token
        } else if (x === ':') {
          tree.height = Number.parseFloat(token)
        }
      }
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
