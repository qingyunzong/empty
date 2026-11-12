package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0306"
)

func ExampleEnumerator_Prefix() {
	dictionary := []string{"a", "b", "c"}
	transactions := []dataeng.Transaction{
		{ID: 1, Weight: 3, Items: []string{"a", "b", "c"}},
		{ID: 2, Weight: 2, Items: []string{"a", "b", "c"}},
		{ID: 3, Weight: 1, Items: []string{"a"}},
	}
	enumerator, err := dataeng.NewEnumerator(dictionary, transactions, 5)
	if err != nil {
		panic(err)
	}
	defer enumerator.Cancel()

	for _, item := range enumerator.Prefix(2) {
		fmt.Printf("%v %d\n", item.Items, item.Support)
	}
	fmt.Printf("attempts=%d intersections=%d\n",
		enumerator.ExtensionAttempts(), enumerator.CoverIntersections())

	// Output:
	// [a] 6
	// [a b c] 5
	// attempts=1 intersections=1
}
