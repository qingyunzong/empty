package page_test

import (
	"fmt"

	"example.org/dataeng/q0161/page"
)

type sliceReader struct{ entries []page.Entry }

func (s sliceReader) ReadEntry(index int) (page.Entry, error) {
	if index < 0 || index >= len(s.entries) {
		return page.Entry{}, fmt.Errorf("entry %d out of range", index)
	}
	return s.entries[index], nil
}

func ExampleOpen_lowerBound() {
	// Caller has already parsed lengths and restart indices from the page.
	entries := []page.Entry{
		{Shared: 0, Suffix: []byte("apple"), Value: []byte("v0")},
		{Shared: 5, Suffix: []byte("s"), Value: []byte("v1")},
		{Shared: 0, Suffix: []byte("banana"), Value: []byte("v2")},
		{Shared: 3, Suffix: []byte("d"), Value: []byte("v3")},
	}
	restarts := []int{0, 2}

	p, err := page.Open(sliceReader{entries: entries}, len(entries), restarts)
	if err != nil {
		panic(err)
	}

	res, ok, err := p.LowerBound([]byte("apples"))
	if err != nil {
		panic(err)
	}
	fmt.Println(ok)
	fmt.Println(res.Index)
	fmt.Printf("%s=%s\n", res.Key, res.Value)
	fmt.Println(res.RebuildChain)

	// Output:
	// true
	// 1
	// apples=v1
	// [0 1]
}
