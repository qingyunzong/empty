package dataeng

// Indices of the seven SI base quantities inside a Dimension vector.
const (
	DimLength = iota
	DimMass
	DimTime
	DimCurrent
	DimTemperature
	DimAmount
	DimLuminosity
	dimCount
)

// Dimension is a vector of integer exponents over the seven SI base
// quantities. Two quantities are commensurable only when their Dimension
// vectors are equal.
type Dimension [dimCount]int8

// Add returns the dimension of a product of two quantities.
func (d Dimension) Add(o Dimension) Dimension {
	var r Dimension
	for i := range r {
		r[i] = d[i] + o[i]
	}
	return r
}

// Sub returns the dimension of a quotient of two quantities.
func (d Dimension) Sub(o Dimension) Dimension {
	var r Dimension
	for i := range r {
		r[i] = d[i] - o[i]
	}
	return r
}

// Pow returns the dimension of a quantity raised to the n-th power.
func (d Dimension) Pow(n int) Dimension {
	var r Dimension
	for i := range r {
		r[i] = d[i] * int8(n)
	}
	return r
}

// IsDimensionless reports whether every exponent is zero.
func (d Dimension) IsDimensionless() bool {
	return d == Dimension{}
}
