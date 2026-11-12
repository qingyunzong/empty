package dataeng

import (
	"math/big"
	"math/bits"
)

// Shapley computes A_i,0, A_i,1, and the exact rational Shapley contribution
// for every fact. With no facts it returns an empty fact map.
func (c *CompiledGraph) Shapley() *ShapleyResult {
	n := len(c.facts)
	result := &ShapleyResult{
		RootSupport: c.RootSupport(),
		Facts:       make(map[string]FactResult),
	}
	if n == 0 {
		return result
	}

	for idx, fact := range c.facts {
		fixedBit := uint64(1) << idx
		aWhenFalse := c.counts(idx, fixedBit, false)
		aWhenTrue := c.counts(idx, fixedBit, true)

		shapley := new(big.Rat)
		numerator := new(big.Int)
		for k := 0; k < n; k++ {
			numerator.Sub(&aWhenTrue[k], &aWhenFalse[k])
			numerator.Mul(numerator, &factorial[k])
			numerator.Mul(numerator, &factorial[n-k-1])
			shapley.Add(shapley, new(big.Rat).SetFrac(numerator, &factorial[n]))
		}

		result.Facts[fact] = FactResult{
			Fact:       fact,
			AWhenFalse: aWhenFalse,
			AWhenTrue:  aWhenTrue,
			Shapley:    shapley,
		}
	}
	return result
}

func (c *CompiledGraph) counts(fixedIdx int, fixedBit uint64, fixedValue bool) []big.Int {
	memo := make(map[string][]big.Int, len(c.nodes))
	rootPolynomial := c.evaluate(c.root, fixedIdx, fixedBit, fixedValue, memo)

	rootDomain := c.support[c.root] &^ fixedBit
	targetDomain := c.universeMask &^ fixedBit
	missingFreeVariables := targetDomain &^ rootDomain
	return multiplyByBinomial(rootPolynomial, bits.OnesCount64(missingFreeVariables))
}

// evaluate returns a polynomial over exactly support(nodeID) minus the fixed
// fact. The memo is specific to one fixed fact and one fixed value.
func (c *CompiledGraph) evaluate(nodeID string, fixedIdx int, fixedBit uint64, fixedValue bool, memo map[string][]big.Int) []big.Int {
	if polynomial, ok := memo[nodeID]; ok {
		return polynomial
	}

	node := c.nodes[nodeID]
	var polynomial []big.Int

	switch node.kind {
	case NodeZero:
		polynomial = zeroPolynomial
	case NodeOne:
		polynomial = onePolynomial
	case NodeAnd:
		polynomial = clonePolynomial(onePolynomial)
		for _, child := range node.children {
			childPolynomial := c.evaluate(child, fixedIdx, fixedBit, fixedValue, memo)
			polynomial = convolve(polynomial, childPolynomial)
		}
	case NodeDecide:
		targetMask := c.support[nodeID] &^ fixedBit
		if node.variableIndex == fixedIdx {
			branchID := node.elseID
			if fixedValue {
				branchID = node.then
			}
			branchPolynomial := c.evaluate(branchID, fixedIdx, fixedBit, fixedValue, memo)
			branchMask := c.support[branchID] &^ fixedBit
			missingFreeVariables := targetMask &^ branchMask
			polynomial = multiplyByBinomial(branchPolynomial, bits.OnesCount64(missingFreeVariables))
		} else {
			decisionBit := uint64(1) << node.variableIndex
			freeTargetMask := targetMask &^ decisionBit

			thenPolynomial := c.evaluate(node.then, fixedIdx, fixedBit, fixedValue, memo)
			thenMask := c.support[node.then] &^ fixedBit
			thenMissing := freeTargetMask &^ thenMask
			thenPolynomial = multiplyByBinomial(thenPolynomial, bits.OnesCount64(thenMissing))
			thenPolynomial = multiplyByZ(thenPolynomial)

			elsePolynomial := c.evaluate(node.elseID, fixedIdx, fixedBit, fixedValue, memo)
			elseMask := c.support[node.elseID] &^ fixedBit
			elseMissing := freeTargetMask &^ elseMask
			elsePolynomial = multiplyByBinomial(elsePolynomial, bits.OnesCount64(elseMissing))

			polynomial = addPolynomials(thenPolynomial, elsePolynomial)
		}
	}

	memo[nodeID] = polynomial
	return polynomial
}
