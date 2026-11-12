// Command columnscan demonstrates a column-scanning host using the index for
// predicate matches without materializing the logical bitmap.
package main

import (
	"fmt"
	"log"

	dataeng "example.org/dataeng/q0311"
)

// ScanColumn visits every row whose predicate bit is one.  Select1 walks the
// match positions directly; each call navigates the checkpoint directory and
// decodes at most one compressed block.
func ScanColumn(ix *dataeng.Index, visit func(row uint64, stats dataeng.QueryStats)) error {
	total := ix.TotalOnes()
	for k := int64(0); k < int64(total); k++ {
		row, found, stats, err := ix.Select1WithStats(k)
		if err != nil {
			return fmt.Errorf("select match %d: %w", k, err)
		}
		if !found {
			return fmt.Errorf("match %d disappeared despite TotalOnes=%d", k, total)
		}
		visit(row, stats)
	}
	return nil
}

func main() {
	const rowCount = 64
	values := make([]int, rowCount)
	allowed := make([]byte, rowCount)
	for row := 0; row < rowCount; row++ {
		values[row] = row * row
		if values[row]%3 == 0 {
			allowed[row] = 1
		}
	}

	ix, err := dataeng.New(allowed, 16, 8)
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("rows=%d matches=%d checkpoints=%d\n",
		ix.Len(), ix.TotalOnes(), ix.CheckpointCount())

	var lastStats dataeng.QueryStats
	matches := 0
	err = ScanColumn(ix, func(row uint64, stats dataeng.QueryStats) {
		matches++
		lastStats = stats
		fmt.Printf("row=%d value=%d headers=%d decoded=%d cacheHits=%d\n",
			row, values[row], stats.BlockHeadersRead, stats.BlocksDecoded, stats.CacheHits)
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("visited=%d last payload ranges=%v\n", matches, lastStats.PayloadBitRanges)

	// A scan host can also use Rank1 to count matches before a row boundary
	// and Access to inspect an individual predicate bit.
	const boundary = uint64(32)
	matchesBefore, stats, err := ix.Rank1WithStats(boundary)
	if err != nil {
		log.Fatal(err)
	}
	bit, _, err := ix.AccessWithStats(boundary)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Rank1(%d)=%d (headers=%d decoded=%d) Access(%d)=%d\n",
		boundary, matchesBefore, stats.BlockHeadersRead, stats.BlocksDecoded, boundary, bit)
}
