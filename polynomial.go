package dataeng

import "math/big"

func convolve(left, right []big.Int) []big.Int {
	result := make([]big.Int, len(left)+len(right)-1)
	product := new(big.Int)
	for i := range left {
		for j := range right {
			product.Mul(&left[i], &right[j])
			result[i+j].Add(&result[i+j], product)
		}
	}
	return result
}

func multiplyByBinomial(polynomial []big.Int, missing int) []big.Int {
	if missing == 0 {
		return clonePolynomial(polynomial)
	}
	binomial := binomialPower[missing]
	result := make([]big.Int, len(polynomial)+missing)
	term := new(big.Int)
	for degree, coefficient := range polynomial {
		for offset, ways := range binomial {
			term.Mul(&coefficient, &ways)
			result[degree+offset].Add(&result[degree+offset], term)
		}
	}
	return result
}

func multiplyByZ(polynomial []big.Int) []big.Int {
	result := make([]big.Int, len(polynomial)+1)
	for degree := range polynomial {
		result[degree+1].Set(&polynomial[degree])
	}
	return result
}

func addPolynomials(left, right []big.Int) []big.Int {
	maxLength := len(left)
	if len(right) > maxLength {
		maxLength = len(right)
	}
	result := make([]big.Int, maxLength)
	for degree := 0; degree < maxLength; degree++ {
		if degree < len(left) {
			result[degree].Add(&result[degree], &left[degree])
		}
		if degree < len(right) {
			result[degree].Add(&result[degree], &right[degree])
		}
	}
	return result
}

func clonePolynomial(polynomial []big.Int) []big.Int {
	result := make([]big.Int, len(polynomial))
	for degree := range polynomial {
		result[degree].Set(&polynomial[degree])
	}
	return result
}
