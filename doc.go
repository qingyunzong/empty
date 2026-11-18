// Package formal builds deterministic, load-conserving range partitions.
//
// A plan assigns ordinary keys to contiguous key ranges and splits skewed keys
// into salted sub-partitions. Partition ranges are half-open, strictly ordered
// and cover the complete string key space. Every observed load unit belongs to
// exactly one partition.
package formal
