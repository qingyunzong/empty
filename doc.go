// Package dataeng normalizes MySQL binlog row events into complete row
// images. It tracks TABLE_MAP generations, completes MINIMAL images from
// versioned pre-images, preserves unsigned integer values, applies partial
// JSON updates, and invalidates old table mappings immediately on DDL.
package dataeng
