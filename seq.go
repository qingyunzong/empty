package srx

// modDist returns the forward modular distance (b-a) mod m, in [0, m).
func modDist(a, b, m int) int {
	d := (b - a) % m
	if d < 0 {
		d += m
	}
	return d
}

// resolveSeq maps a wire sequence number to the absolute sequence number
// nearest to ref. The mapping is unambiguous because every live sequence
// number stays within a window strictly smaller than m/2 of ref.
func resolveSeq(wire, ref, m int) int {
	d := modDist(ref%m, wire, m)
	if 2*d <= m {
		return ref + d
	}
	return ref + d - m
}
