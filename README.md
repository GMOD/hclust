# @gmod/hclust

This package provides fast hierarchical clustering algorithms compiled from C to
WebAssembly, with JavaScript/TypeScript wrappers for easy integration.

## Features

- Fast distance matrix computation using WASM
- Float32 precision for memory efficiency
- Hierarchical clustering with average linkage
- Multiple output formats including Newick, JSON, and tree visualization
- Includes the ability to cancel the calculation when it's running in a web
  worker using synchronous XHR (something that is allowable)

## Usage

```typescript
import { clusterData, printTree, toNewick } from '@gmod/hclust'

const data = [
  [1.0, 2.0, 3.0],
  [1.5, 2.5, 3.5],
  [10.0, 11.0, 12.0],
]

const result = await clusterData(data)

// Print tree structure
printTree(result.tree, ['Sample A', 'Sample B', 'Sample C'])

// Get Newick format
const newick = toNewick(result.tree)
```

## Note

Generated with the help of Claude Code AI, you might be able to tell from the
somewhat robotic documentation
