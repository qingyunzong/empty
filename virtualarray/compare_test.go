package virtualarray

import "testing"

// ordersFor builds an order map from names.
func ordersFor(order Order, names ...string) map[string]Order {
	m := map[string]Order{}
	for _, n := range names {
		m[n] = order
	}
	return m
}

// assertAgainstReference compares a package ReadResult against the
// fully-expanded oracle for a small read.
func assertAgainstReference(t *testing.T, got *ReadResult, ref refResult) {
	t.Helper()
	if len(got.Values) != len(ref.values) {
		t.Fatalf("value count = %d, want %d", len(got.Values), len(ref.values))
	}
	for i := range got.Values {
		if got.Values[i] != ref.values[i] {
			t.Fatalf("value[%d] = %d, want %d", i, got.Values[i], ref.values[i])
		}
		if got.Points[i].Filled != ref.filled[i] || got.Points[i].FillReason != ref.reasons[i] {
			t.Fatalf("fill[%d] = (%v,%s), want (%v,%s)", i,
				got.Points[i].Filled, got.Points[i].FillReason,
				ref.filled[i], ref.reasons[i])
		}
		if got.Points[i].MappingIndex != ref.maps[i] {
			t.Fatalf("mapping[%d] = %d, want %d", i, got.Points[i].MappingIndex, ref.maps[i])
		}
		if got.Points[i].SourceName != ref.source[i] {
			t.Fatalf("source[%d] = %q, want %q", i, got.Points[i].SourceName, ref.source[i])
		}
		if ref.filled[i] {
			if got.Points[i].SourceCoord != nil {
				t.Fatalf("filled point[%d] must have nil source coord", i)
			}
			continue
		}
		if len(got.Points[i].SourceCoord) != len(ref.scoord[i]) {
			t.Fatalf("source coord rank[%d] = %d, want %d", i,
				len(got.Points[i].SourceCoord), len(ref.scoord[i]))
		}
		for d, c := range ref.scoord[i] {
			if got.Points[i].SourceCoord[d].Int64() != c {
				t.Fatalf("source coord[%d][%d] = %d, want %d", i, d,
					got.Points[i].SourceCoord[d].Int64(), c)
			}
		}
	}
}
