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

export function toNewick(node: ClusterNode): string {
  if (!node.children || node.children.length === 0) {
    return node.name
  }

  const childStrings = node.children.map(child => toNewick(child))
  return `(${childStrings.join(',')})${node.height.toFixed(4)}`
}

export function fromNewick(s: string): ClusterNode {
  const ancestors: ClusterNode[] = []

  let tree = {} as ClusterNode
  const tokens = s.split(/\s*(;|\(|\)|,|:)\s*/)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const subtree = {} as ClusterNode
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
      case ':':
        break
      default: {
        const x = tokens[i - 1]
        if (
          x === ')' ||
          x === '(' ||
          x === ',' ||
          x === undefined ||
          x === ''
        ) {
          tree.name = token
        } else if (x === ':') {
          tree.height = Number.parseFloat(token)
        }
      }
    }
  }

  function fillDefaults(node: ClusterNode) {
    if (!node.name) {
      node.name = ''
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (node.height === undefined) {
      node.height = 0
    }
    if (node.children) {
      for (const child of node.children) {
        fillDefaults(child)
      }
    }
  }

  fillDefaults(tree)
  return tree
}

export function treeToJSON(node: ClusterNode) {
  const result: {
    name: string
    height: number
    children?: ReturnType<typeof treeToJSON>[]
  } = {
    name: node.name,
    height: node.height,
  }

  if (node.children && node.children.length > 0) {
    result.children = node.children.map(child => treeToJSON(child))
  }

  return result
}
