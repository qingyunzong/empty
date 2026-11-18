// Package formal provides a filesystem namespace model with exact quota
// accounting for directory subtrees.
//
// Every directory carries a Usage value describing its whole subtree:
//
//   - Links is the number of namespace entries (hard links) in the subtree.
//   - Inodes is the number of distinct inodes referenced by those entries.
//   - Bytes is the sum of the sizes of those distinct inodes.
//
// Distinct-inode accounting is important for hard links: a file with several
// links in one subtree consumes one inode and its size is charged once, while
// every namespace entry still contributes to Links.
package formal
