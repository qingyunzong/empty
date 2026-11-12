package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0305"
)

// ExampleBuilder demonstrates the host build and query workflow.
func ExampleBuilder() {
	entries := []struct {
		term  string
		value uint64
	}{
		{"ant", 5},
		{"car", 12},
		{"cat", 42},
		{"dog", 9},
	}

	builder := dataeng.NewBuilder()
	for _, entry := range entries {
		if err := builder.Add([]byte(entry.term), entry.value); err != nil {
			panic(err)
		}
	}
	graph, err := builder.Finish()
	if err != nil {
		panic(err)
	}

	value, found, err := graph.Lookup([]byte("cat"))
	if err != nil {
		panic(err)
	}
	fmt.Println(value, found)

	rank, err := graph.Rank([]byte("car"))
	if err != nil {
		panic(err)
	}
	fmt.Println(rank)

	key, value, found, err := graph.Select(2)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(key), value, found)

	_, _, found, err = graph.Select(4)
	if err != nil {
		panic(err)
	}
	fmt.Println(found)

	// Output:
	// 42 true
	// 1
	// cat 42 true
	// false
}
