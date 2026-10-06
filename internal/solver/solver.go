// Package solver implements exact solvers and brute-force verifiers for the
// travel fare optimization CLI.
//
// Objective (both problems): minimize total cost, then ticket count, then the
// lexicographically smallest sorted ticket-ID sequence.
package solver

import "sort"

// betterTriple reports whether (costA, countA, idsA) is strictly better than
// (costB, countB, idsB). The id slices must be sorted.
func betterTriple(costA, countA int, idsA []string, costB, countB int, idsB []string) bool {
	switch {
	case costA != costB:
		return costA < costB
	case countA != countB:
		return countA < countB
	}
	return compareIDs(idsA, idsB) < 0
}

// compareIDs lexicographically compares two sorted id slices.
func compareIDs(a, b []string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// insertSorted returns a new sorted slice with id inserted. s must be sorted
// and must not already contain id.
func insertSorted(s []string, id string) []string {
	i := sort.SearchStrings(s, id)
	out := make([]string, 0, len(s)+1)
	out = append(out, s[:i]...)
	out = append(out, id)
	out = append(out, s[i:]...)
	return out
}
