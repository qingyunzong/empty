package markov

import "testing"

func TestExpectedToTargetAbsorbing(t *testing.T) {
	c := chainA(t)
	res, err := c.ExpectedToTarget(c.Index("T"))
	if err != nil {
		t.Fatalf("ExpectedToTarget: %v", err)
	}
	ratEq(t, res[c.Index("A")].Value, "6")
	ratEq(t, res[c.Index("B")].Value, "4")
	ratEq(t, res[c.Index("T")].Value, "0")
}

func TestExpectedToTargetDivergent(t *testing.T) {
	c := chainB(t)
	res, err := c.ExpectedToTarget(c.Index("T"))
	if err != nil {
		t.Fatalf("ExpectedToTarget: %v", err)
	}
	if got := res[c.Index("S")].Status; got != DivergesPlus {
		t.Errorf("S: status %v, want DivergesPlus", got)
	}
	for _, nm := range []string{"D1", "D2"} {
		if got := res[c.Index(nm)].Status; got != DivergesPlus {
			t.Errorf("%s: status %v, want DivergesPlus", nm, got)
		}
	}
	if r := res[c.Index("Z")]; r.Status != Finite || r.Value.Sign() != 0 {
		t.Errorf("Z: got %v %v, want Finite 0", r.Status, r.Value)
	}
	ratEq(t, res[c.Index("T")].Value, "0")
}

func TestExpectedToTargetZeroClassBoundary(t *testing.T) {
	c := chainC(t)
	res, err := c.ExpectedToTarget(c.Index("T"))
	if err != nil {
		t.Fatalf("ExpectedToTarget: %v", err)
	}
	// The target is hit only with probability 1/2, but the zero-reward
	// closed class contributes nothing, so the cumulative reward is finite.
	ratEq(t, res[c.Index("S")].Value, "4")
	ratEq(t, res[c.Index("Z")].Value, "0")
}

func TestExpectedToTargetZeroMeanClass(t *testing.T) {
	c := chainD(t)
	res, err := c.ExpectedToTarget(c.Index("T"))
	if err != nil {
		t.Fatalf("ExpectedToTarget: %v", err)
	}
	ratEq(t, res[c.Index("S")].Value, "1/3")
	ratEq(t, res[c.Index("U")].Value, "2/3")
	ratEq(t, res[c.Index("V")].Value, "-4/3")
}

func TestExpectedToTargetBadIndex(t *testing.T) {
	c := chainA(t)
	if _, err := c.ExpectedToTarget(7); err == nil {
		t.Error("expected error for out-of-range target")
	}
}

func TestVerify(t *testing.T) {
	for _, build := range []func(*testing.T) *Chain{chainA, chainB, chainC, chainD} {
		c := build(t)
		v, err := c.Verify(0, []int{c.NumStates() - 1}, 5)
		if err != nil {
			t.Fatalf("Verify: %v", err)
		}
		if v.Residual.Sign() != 0 {
			t.Errorf("residual %s, want 0", v.Residual)
		}
		if !v.BareissOK {
			t.Error("Bareiss and Gauss disagree")
		}
		if !v.ShortOK {
			t.Errorf("short-step check: iteration %s != enumeration %s",
				v.ShortIter, v.ShortEnum)
		}
	}
}
