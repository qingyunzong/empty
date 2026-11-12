package dataeng

import (
	"fmt"
	"math/big"
)

func ExampleCompile() {
	g := &Graph{
		Facts: []string{"a", "b"},
		Root:  "and",
		Nodes: append(
			[]Node{{ID: "and", Kind: NodeAnd, Children: []string{"a", "b"}}},
			literalNodes("a", "b")...,
		),
	}

	compiled, err := Compile(g)
	if err != nil {
		panic(err)
	}
	result := compiled.Shapley()
	for _, fact := range compiled.Facts() {
		contribution := result.Facts[fact]
		fmt.Printf("%s A0=%v A1=%v phi=%s\n", fact, bigIntStrings(contribution.AWhenFalse), bigIntStrings(contribution.AWhenTrue), contribution.Shapley)
	}

	// Output:
	// a A0=[0 0] A1=[0 1] phi=1/2
	// b A0=[0 0] A1=[0 1] phi=1/2
}

func bigIntStrings(values []big.Int) []string {
	result := make([]string, len(values))
	for i := range values {
		result[i] = values[i].String()
	}
	return result
}
