# Newick output

`toNewick` writes a cluster's merge height as the `:` branch length above it,
which is what every other reader of the format expects:

```js
toNewick({
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
// '((A:1.0000,B:1.0000):1.0000,C:2.0000)'
```

The absolute heights survive the trip. UPGMA is monotonic —
`src/wasm/distance.c` clamps the tiny inversions repeated Lance-Williams updates
produce on near-tied data — so a node's height is the root's minus the lengths
on the path down to it, and `fromNewick` recovers them that way:

```js
fromNewick('((A:1.0000,B:1.0000):1.0000,C:2.0000)')
// { name: '', height: 2, children: [
//   { name: '', height: 1, children: [
//     { name: 'A', height: 0 },
//     { name: 'B', height: 0 },
//   ] },
//   { name: 'C', height: 0 },
// ] }
```

## What v4 wrote, and why it changed

Through v4 `toNewick` put the height in the internal node's _label_ instead:

```
((A,B)1.0000,C)2.0000
```

That is a legal Newick string, and nothing rejects it. It is also read as
something else entirely by every mainstream viewer: a numeric internal label is
a bootstrap support value to iTOL, FigTree, MEGA, RAxML, IQ-TREE and MrBayes, so
an exported dendrogram loaded as an unlengthed cladogram carrying support values
of 1.0 and 2.0. FigTree compounds it — rerooting assumes the branch
interpretation, which maps those labels onto the wrong nodes. The failure was
silent in every case: the file parsed, and drew the wrong tree.

The standard conversion goes the other way. R's `ape::as.phylo.hclust` turns
`hclust` merge heights into edge lengths and `write.tree` emits them as `:`
lengths.

`fromNewick` still reads the v4 form, so a stored string keeps working:

```js
fromNewick('((A,B)1.0000,C)2.0000')
// same tree as above — root height 2, inner node 1, leaves 0
```

## Telling the two apart

`fromNewick` parses once with `postParenNumeric: 'name'`, where a `length` can
only have come from a `:` token. None anywhere means the string carries no
branch lengths at all, so its post-paren numbers are v4 heights and a second
pass re-reads them as lengths.

Deciding on which _nodes_ carry a length would be wrong. `((A,B)E:0.5,C);` is a
phylogeny whose leaves happen to carry none, and reading `0.5` as an absolute
height inverts it.

A real phylogeny is safe either way, because its bootstrap values sit in a tree
that does have `:` lengths:

```js
fromNewick('((A:1,B:1)95,(C:1,D:1)80);')
// the clades are named '95' and '80'; heights come from the lengths
```

## Precision

Lengths are the difference of two heights each already rounded to 4 decimal
places, not the rounded difference of two raw heights. The distinction is
whether error accumulates: printed this way the lengths telescope, so summing
them down any path lands exactly on the printed root height. Differencing the
raw heights instead loses up to 5e-5 per level, which over the thousands of
levels a caterpillar dendrogram reaches is a visible shift.
