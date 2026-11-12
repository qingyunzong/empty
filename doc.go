// Package dataeng reads fixed-width rows from a column file using a validated
// footer page index. It reads only pages intersecting the requested row
// interval and verifies each page's decoded length and SHA-256 digest.
package dataeng
