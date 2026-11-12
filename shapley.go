package dataeng

import (
	"math/big"
)

const (
	maxFacts = 60
	maxNodes = 5000
)

// NodeKind identifies one of the permitted structural node forms.
type NodeKind int

const (
	NodeZero NodeKind = iota
	NodeOne
	NodeAnd
	NodeDecide
)

// Node is a Boolean lineage DAG node.
//
// NodeAnd uses Children; an empty Children slice is the constant 1.
// NodeDecide uses Variable, Then, and Else. Fields not applicable to a kind
// are ignored.
type Node struct {
	ID       string
	Kind     NodeKind
	Children []string
	Variable string
	Then     string
	Else     string
}

// Graph is an immutable lineage graph specification. Compile copies the graph,
// so later changes to the caller's slices do not affect a compiled graph.
type Graph struct {
	Facts []string
	Nodes []Node
	Root  string
}

type compiledNode struct {
	kind          NodeKind
	children      []string
	variableIndex int
	then          string
	elseID        string
}

// CompiledGraph is a validated DAG together with every node's structural
// variable-support set. It is safe for concurrent Shapley calls.
type CompiledGraph struct {
	facts        []string
	factIndex    map[string]int
	nodes        map[string]compiledNode
	nodeIDs      []string
	root         string
	support      map[string]uint64
	universeMask uint64
}

// FactResult contains exact cardinality counts and a Shapley contribution.
type FactResult struct {
	Fact       string
	AWhenFalse []big.Int
	AWhenTrue  []big.Int
	Shapley    *big.Rat
}

// ShapleyResult contains root support and the result for every fact in V.
type ShapleyResult struct {
	RootSupport []string
	Facts       map[string]FactResult
}

var (
	factorial      [maxFacts + 1]big.Int
	binomialPower  [maxFacts + 1][]big.Int
	zeroPolynomial = []big.Int{{}}
	onePolynomial  = []big.Int{*big.NewInt(1)}
)

func init() {
	factorial[0].SetInt64(1)
	for i := 1; i <= maxFacts; i++ {
		factorial[i].Mul(&factorial[i-1], big.NewInt(int64(i)))
	}

	for n := 0; n <= maxFacts; n++ {
		binomialPower[n] = make([]big.Int, n+1)
		for k := 0; k <= n; k++ {
			binomialPower[n][k].Binomial(int64(n), int64(k))
		}
	}
}
