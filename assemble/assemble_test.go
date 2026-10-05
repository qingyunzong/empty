package assemble

import (
	"math/big"
	"testing"
)

func rat(v int64) *big.Rat { return big.NewRat(v, 1) }

func rats(vs ...int64) []*big.Rat {
	out := make([]*big.Rat, len(vs))
	for i, v := range vs {
		out[i] = rat(v)
	}
	return out
}

// solveDense solves A x = b exactly via Gaussian elimination over the
// rationals. It is an independent reference used only by tests.
func solveDense(a [][]*big.Rat, b []*big.Rat) ([]*big.Rat, bool) {
	n := len(b)
	m := make([][]*big.Rat, n)
	for i := range m {
		m[i] = make([]*big.Rat, n+1)
		for j := 0; j < n; j++ {
			m[i][j] = new(big.Rat).Set(a[i][j])
		}
		m[i][n] = new(big.Rat).Set(b[i])
	}
	for col := 0; col < n; col++ {
		piv := -1
		for r := col; r < n; r++ {
			if m[r][col].Sign() != 0 {
				piv = r
				break
			}
		}
		if piv < 0 {
			return nil, false
		}
		m[col], m[piv] = m[piv], m[col]
		inv := new(big.Rat).Inv(m[col][col])
		for j := col; j <= n; j++ {
			m[col][j].Mul(m[col][j], inv)
		}
		for r := 0; r < n; r++ {
			if r == col || m[r][col].Sign() == 0 {
				continue
			}
			f := new(big.Rat).Set(m[r][col])
			for j := col; j <= n; j++ {
				m[r][j].Sub(m[r][j], new(big.Rat).Mul(f, m[col][j]))
			}
		}
	}
	x := make([]*big.Rat, n)
	for i := range x {
		x[i] = m[i][n]
	}
	return x, true
}

// checkAgainstDense compares the assembler state with the independent
// dense assembly of the given live elements.
func checkAgainstDense(t *testing.T, s *Assembler, live []*Element) {
	t.Helper()
	da, db, err := DenseAssemble(s.Dim(), live)
	if err != nil {
		t.Fatalf("DenseAssemble: %v", err)
	}
	for i := 0; i < s.Dim(); i++ {
		if s.RHSAt(i).Cmp(db[i]) != 0 {
			t.Fatalf("rhs[%d] = %v, dense reference %v", i, s.RHSAt(i), db[i])
		}
		for j := 0; j < s.Dim(); j++ {
			if s.At(i, j).Cmp(da[i][j]) != 0 {
				t.Fatalf("A[%d][%d] = %v, dense reference %v", i, j, s.At(i, j), da[i][j])
			}
		}
	}
}

func TestDuplicateIndicesAccumulate(t *testing.T) {
	s := New(2)
	// Element with repeated global index 1: contributions accumulate.
	dup := NewElement(
		[][]int64{{1, 2, 3}, {4, 5, 6}, {7, 8, 9}},
		[]int64{10, 20, 30},
		[]int{0, 1, 1},
	)
	if err := s.Add(dup); err != nil {
		t.Fatal(err)
	}
	// A[1][1] receives 5 + 6 + 8 + 9 = 28; b[1] receives 20 + 30 = 50.
	if got := s.At(1, 1); got.Cmp(rat(28)) != 0 {
		t.Fatalf("A[1][1] = %v, want 28", got)
	}
	if got := s.RHSAt(1); got.Cmp(rat(50)) != 0 {
		t.Fatalf("b[1] = %v, want 50", got)
	}
	// Two elements touching the same global entry also accumulate.
	e2 := NewElement([][]int64{{1}}, []int64{1}, []int{1})
	if err := s.Add(e2); err != nil {
		t.Fatal(err)
	}
	if got := s.At(1, 1); got.Cmp(rat(29)) != 0 {
		t.Fatalf("A[1][1] = %v, want 29", got)
	}
	checkAgainstDense(t, s, []*Element{dup, e2})
}

func TestAddAtomicOnInvalidElement(t *testing.T) {
	s := New(2)
	good := NewElement([][]int64{{2, -1}, {-1, 2}}, []int64{1, 1}, []int{0, 1})
	if err := s.Add(good); err != nil {
		t.Fatal(err)
	}
	before := s.Matrix()
	bad := NewElement([][]int64{{1}}, []int64{1}, []int{7}) // out of range
	if err := s.Add(bad); err == nil {
		t.Fatal("expected error for out-of-range index")
	}
	if s.Len() != 1 {
		t.Fatalf("Len = %d, want 1 after rejected add", s.Len())
	}
	after := s.Matrix()
	for i := range before {
		for j := range before[i] {
			if before[i][j].Cmp(after[i][j]) != 0 {
				t.Fatalf("state mutated by rejected add at (%d,%d)", i, j)
			}
		}
	}
}

func TestUndoAtomicRollback(t *testing.T) {
	s := New(3)
	e1 := NewElement([][]int64{{4, 1}, {1, 4}}, []int64{1, 2}, []int{0, 1})
	e2 := NewElement([][]int64{{9, -3}, {-3, 9}}, []int64{3, 4}, []int{1, 2})
	e3 := NewElement([][]int64{{2}}, []int64{5}, []int{2})
	live := []*Element{}
	for _, e := range []*Element{e1, e2, e3} {
		if err := s.Add(e); err != nil {
			t.Fatal(err)
		}
		live = append(live, e)
		checkAgainstDense(t, s, live)
	}
	// Undo all elements one by one; each step must match the dense
	// reference of the remaining elements exactly.
	for len(live) > 0 {
		if err := s.Undo(); err != nil {
			t.Fatal(err)
		}
		live = live[:len(live)-1]
		checkAgainstDense(t, s, live)
	}
	// Undo on an empty journal is an atomic no-op with an error.
	if err := s.Undo(); err == nil {
		t.Fatal("expected error undoing empty assembler")
	}
	checkAgainstDense(t, s, nil)
	if s.Len() != 0 {
		t.Fatalf("Len = %d, want 0", s.Len())
	}
}

func TestEliminatePreservesRHSContribution(t *testing.T) {
	// Truss-like 3x3 system:
	//   [ 4 -1  0 ]       [ 1 ]
	//   [-1  4 -1 ] x =   [ 2 ]
	//   [ 0 -1  4 ]       [ 3 ]
	s := New(3)
	e1 := NewElement([][]int64{{4, -1}, {-1, 4}}, []int64{1, 2}, []int{0, 1})
	e2 := NewElement([][]int64{{4, -1}, {-1, 4}}, []int64{0, 3}, []int{1, 2})
	if err := s.Add(e1); err != nil {
		t.Fatal(err)
	}
	if err := s.Add(e2); err != nil {
		t.Fatal(err)
	}
	origA, origB := s.Matrix(), s.RHS()
	full, err := s.Certify(mustSolve(t, origA, origB))
	if err != nil || !full.Exact {
		t.Fatalf("pre-elimination certificate: %+v err=%v", full, err)
	}

	// Constrain x[0] = 5. The column-0 contribution must move to the RHS.
	if err := s.Eliminate(0, rat(5)); err != nil {
		t.Fatal(err)
	}
	// Row/column 0 are the identity row.
	if s.At(0, 0).Cmp(rat(1)) != 0 || s.At(0, 1).Sign() != 0 || s.At(1, 0).Sign() != 0 {
		t.Fatalf("constraint row/column not canonical: %v %v %v", s.At(0, 0), s.At(0, 1), s.At(1, 0))
	}
	if s.RHSAt(0).Cmp(rat(5)) != 0 {
		t.Fatalf("b[0] = %v, want 5", s.RHSAt(0))
	}
	// b[1] = 2 - (-1)*5 = 7: the eliminated column's RHS contribution.
	if s.RHSAt(1).Cmp(rat(7)) != 0 {
		t.Fatalf("b[1] = %v, want 7 (RHS contribution not preserved)", s.RHSAt(1))
	}
	if s.RHSAt(2).Cmp(rat(3)) != 0 {
		t.Fatalf("b[2] = %v, want 3", s.RHSAt(2))
	}
	// The reduced system solves exactly and respects the constraint.
	x := mustSolve(t, s.Matrix(), s.RHS())
	if x[0].Cmp(rat(5)) != 0 {
		t.Fatalf("x[0] = %v, want constrained value 5", x[0])
	}
	cert, err := s.Certify(x)
	if err != nil {
		t.Fatal(err)
	}
	if !cert.Exact {
		t.Fatalf("residual certificate not exact: max norm %v", cert.MaxNorm)
	}
	// The reduced solution also satisfies the original equations in the
	// free rows (rows 1 and 2 of the unconstrained system).
	for _, row := range []int{1, 2} {
		lhs := new(big.Rat)
		for j := 0; j < 3; j++ {
			lhs.Add(lhs, new(big.Rat).Mul(origA[row][j], x[j]))
		}
		if lhs.Cmp(origB[row]) != 0 {
			t.Fatalf("original row %d violated: lhs %v != rhs %v", row, lhs, origB[row])
		}
	}
}

func TestResidualCertificate(t *testing.T) {
	s := New(2)
	e := NewElement([][]int64{{2, 1}, {1, 3}}, []int64{1, 2}, []int{0, 1})
	if err := s.Add(e); err != nil {
		t.Fatal(err)
	}
	x := mustSolve(t, s.Matrix(), s.RHS())
	cert, err := s.Certify(x)
	if err != nil {
		t.Fatal(err)
	}
	if !cert.Exact || cert.MaxNorm.Sign() != 0 {
		t.Fatalf("exact solution not certified: %+v", cert)
	}
	// A wrong solution yields a certificate exposing the residual.
	bad := rats(1, 1)
	certBad, err := s.Certify(bad)
	if err != nil {
		t.Fatal(err)
	}
	if certBad.Exact {
		t.Fatal("wrong solution certified as exact")
	}
	// r = A*(1,1)^T - b = (3,4)^T - (1,2)^T = (2,2)^T.
	for i, want := range []int64{2, 2} {
		if certBad.Residual[i].Cmp(rat(want)) != 0 {
			t.Fatalf("residual[%d] = %v, want %d", i, certBad.Residual[i], want)
		}
	}
	if certBad.MaxNorm.Cmp(rat(2)) != 0 {
		t.Fatalf("max norm = %v, want 2", certBad.MaxNorm)
	}
}

func TestDegenerateSystems(t *testing.T) {
	// Zero-dimension system: certificate of the empty vector is exact.
	z := New(0)
	cert, err := z.Certify([]*big.Rat{})
	if err != nil {
		t.Fatal(err)
	}
	if !cert.Exact || cert.MaxNorm.Sign() != 0 {
		t.Fatalf("zero-dim certificate: %+v", cert)
	}

	// Empty element (no indices) is a legal no-op contribution.
	s := New(2)
	empty := NewElement([][]int64{}, []int64{}, []int{})
	if err := s.Add(empty); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo(); err != nil {
		t.Fatal(err)
	}
	checkAgainstDense(t, s, nil)

	// Zero-matrix element leaves the system untouched.
	zero := NewElement([][]int64{{0, 0}, {0, 0}}, []int64{0, 0}, []int{0, 1})
	if err := s.Add(zero); err != nil {
		t.Fatal(err)
	}
	checkAgainstDense(t, s, []*Element{zero})
	if err := s.Undo(); err != nil {
		t.Fatal(err)
	}

	// Singular (degenerate) system: certificates are still computable
	// and distinguish solutions from non-solutions.
	sing := New(2)
	row := NewElement([][]int64{{1, 1}, {1, 1}}, []int64{2, 2}, []int{0, 1})
	if err := sing.Add(row); err != nil {
		t.Fatal(err)
	}
	okCert, err := sing.Certify(rats(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if !okCert.Exact {
		t.Fatal("x=(1,1) solves the singular system, want exact certificate")
	}
	badCert, err := sing.Certify(rats(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if badCert.Exact || badCert.MaxNorm.Cmp(rat(1)) != 0 {
		t.Fatalf("singular residual = %+v, want max norm 1", badCert)
	}

	// Eliminating every dof reduces the system to a pure identity map.
	full := New(2)
	fe := NewElement([][]int64{{3, 1}, {1, 3}}, []int64{4, 8}, []int{0, 1})
	if err := full.Add(fe); err != nil {
		t.Fatal(err)
	}
	if err := full.Eliminate(0, rat(1)); err != nil {
		t.Fatal(err)
	}
	if err := full.Eliminate(1, rat(3)); err != nil {
		t.Fatal(err)
	}
	c, err := full.Certify(rats(1, 3))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Exact {
		t.Fatalf("fully constrained system: residual %+v", c.Residual)
	}
}

func mustSolve(t *testing.T, a [][]*big.Rat, b []*big.Rat) []*big.Rat {
	t.Helper()
	x, ok := solveDense(a, b)
	if !ok {
		t.Fatal("reference solver: system is singular")
	}
	return x
}
