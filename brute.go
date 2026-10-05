package automata

// BruteForceDifference enumerates all strings over the joint alphabet
// up to length maxLen, shortest first and in byte order within one
// length, and returns the first string on which a and b disagree. The
// second return value reports whether such a string was found within
// the length bound. It is an independent cross-check for Compare.
func BruteForceDifference(a, b *NFA, maxLen int) (string, bool) {
	alpha := unionAlphabet(a, b)
	queue := []string{""}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		if a.Accepts(s) != b.Accepts(s) {
			return s, true
		}
		if len(s) < maxLen {
			for _, c := range alpha {
				queue = append(queue, s+string(c))
			}
		}
	}
	return "", false
}
