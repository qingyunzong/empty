// Package dataeng provides range-partition boundary planning for distributed
// sort and shuffle jobs.
//
// A planner combines weighted key samples collected from one or more shards,
// estimates the row load of every observed key, and chooses P contiguous key
// ranges.  The primary objective is to minimize the largest estimated range
// load.  Duplicate observations of the same key are always kept in one range,
// so a repeated heavy key can become a range of its own.  Range boundaries are
// inclusive upper bounds and are returned in ascending key order.
package dataeng
