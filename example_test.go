package cfglib_test

import (
	"fmt"

	"cfglib"
)

// Example builds a small control-flow graph, mutates it, and prints the
// maintained dominator evidence for the new version. The old version
// remains readable.
func Example() {
	g1 := cfglib.New("A").
		AddEdge("A", "B").AddEdge("A", "C").
		AddEdge("B", "D").AddEdge("C", "D").
		AddEdge("D", "E").AddNode("Z")

	g2 := g1.RemoveEdge("C", "D") // new version; g1 is untouched

	a := g2.Analyze()
	fmt.Print(a.String())

	ncd, _ := a.NearestCommonDominator("B", "D")
	fmt.Println("NCD(B, D) =", ncd)

	old := g1.Analyze()
	idomD, _ := old.ImmediateDominator("D")
	fmt.Println("old version", g1.Version(), "idom(D) =", idomD)

	// Output:
	// graph version 7 (entry A)
	//   A: idom=A doms={A} DF={}
	//   B: idom=A doms={A B} DF={}
	//   C: idom=A doms={A C} DF={}
	//   D: idom=B doms={A B D} DF={}
	//   E: idom=D doms={A B D E} DF={}
	//   Z: unreachable
	// NCD(B, D) = B
	// old version 6 idom(D) = A
}
