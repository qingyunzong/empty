// Command seatbank allocates groups of people to consecutive seats in a
// single row. Input on stdin:
//
//	N T G            row length, 1-based target column, number of groups (<=10)
//	rowstring        N chars: '.' usable, '#' blocked
//	s1 s2 ... sG     group sizes
//
// It minimizes the number of unseated people first, then the total absolute
// distance of seated people to the target column, and prints the layout.
package main

import (
	"bufio"
	"fmt"
	"os"
)

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "seatbank: "+format+"\n", args...)
	os.Exit(1)
}

func main() {
	in := bufio.NewReader(os.Stdin)
	var n, target, g int
	if _, err := fmt.Fscan(in, &n, &target, &g); err != nil {
		fatal("expected: N T G")
	}
	if n < 1 {
		fatal("N must be >= 1")
	}
	if target < 1 || target > n {
		fatal("target column T must be in [1, N]")
	}
	if g < 0 || g > 10 {
		fatal("number of groups G must be in [0, 10]")
	}
	var row string
	if _, err := fmt.Fscan(in, &row); err != nil || len(row) != n {
		fatal("expected a row string of length %d", n)
	}
	available := make([]bool, n)
	for i := 0; i < n; i++ {
		switch row[i] {
		case '.':
			available[i] = true
		case '#':
		default:
			fatal("row string must contain only '.' and '#'")
		}
	}
	sizes := make([]int, g)
	for i := range sizes {
		if _, err := fmt.Fscan(in, &sizes[i]); err != nil || sizes[i] < 1 {
			fatal("group sizes must be positive integers")
		}
	}

	res := Solve(available, sizes, target-1)
	fmt.Println("unseated:", res.Unseated)
	fmt.Println("distance:", res.Distance)
	fmt.Println("layout:  ", res.Layout)
	for _, p := range res.Placements {
		fmt.Printf("group %c (size %d): columns %d-%d\n",
			'A'+p.Group, sizes[p.Group], p.Start+1, p.Start+sizes[p.Group])
	}
}
