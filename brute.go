package automata

// FindDiffBrute enumerates all strings over the union alphabet of a and b
// in order of increasing length, then ascending byte order, up to maxLen
// symbols, and returns the first string on which a and b disagree. The
// second return value reports whether such a string was found within the
// length bound.
func FindDiffBrute(a, b *NFA, maxLen int) (string, bool) {
	alpha := unionAlphabet(a, b)
	if len(alpha) == 0 {
		if a.Eval("") != b.Eval("") {
			return "", true
		}
		return "", false
	}
	// cur holds the current string as indexes into alpha, incremented in
	// little-endian (rightmost fastest) order to enumerate byte order.
	cur := []int{}
	for length := 0; length <= maxLen; length++ {
		cur = make([]int, length)
		for {
			s := materialize(alpha, cur)
			if a.Eval(s) != b.Eval(s) {
				return s, true
			}
			if !next(alpha, cur) {
				break
			}
		}
	}
	return "", false
}

func materialize(alpha []byte, idx []int) string {
	s := make([]byte, len(idx))
	for i, v := range idx {
		s[i] = alpha[v]
	}
	return string(s)
}

// next advances idx to the next combination in byte order; it returns false
// when idx was the last combination.
func next(alpha []byte, idx []int) bool {
	for i := len(idx) - 1; i >= 0; i-- {
		if idx[i] < len(alpha)-1 {
			idx[i]++
			for j := i + 1; j < len(idx); j++ {
				idx[j] = 0
			}
			return true
		}
	}
	return false
}
