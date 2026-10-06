package pieceaffine

// floorDiv returns floor(a / b), rounding toward negative infinity.
// b must be non-zero.
func floorDiv(a, b int64) int64 {
	q := a / b
	r := a % b
	if r != 0 && (r < 0) != (b < 0) {
		q--
	}
	return q
}

// ceilDiv returns ceil(a / b), rounding toward positive infinity.
// b must be non-zero.
func ceilDiv(a, b int64) int64 {
	return -floorDiv(-a, b)
}
