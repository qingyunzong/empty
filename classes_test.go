package markov

import (
	"strings"
	"testing"
)

func findClass(classes []*Class, state int) *Class {
	for _, cl := range classes {
		for _, s := range cl.States {
			if s == state {
				return cl
			}
		}
	}
	return nil
}

func TestClosedClassClassification(t *testing.T) {
	c := chainB(t)
	classes := c.Classes()

	z := findClass(classes, c.Index("Z"))
	if z == nil || !z.Closed || z.Kind != ClosedZeroReward {
		t.Fatalf("class of Z: got %+v, want closed zero-reward", z)
	}
	ratEq(t, z.MeanReward, "0")

	d := findClass(classes, c.Index("D1"))
	if d == nil || !d.Closed || d.Kind != ClosedDivergent {
		t.Fatalf("class of D1: got %+v, want closed divergent", d)
	}
	if len(d.States) != 2 {
		t.Fatalf("divergent class states = %v, want 2 members", d.States)
	}
	ratEq(t, d.Stationary[0], "1/2")
	ratEq(t, d.Stationary[1], "1/2")
	ratEq(t, d.MeanReward, "3/2")

	s := findClass(classes, c.Index("S"))
	if s == nil || s.Closed || s.Kind != TransientClass {
		t.Fatalf("class of S: got %+v, want transient", s)
	}
}

func TestClassEvidence(t *testing.T) {
	c := chainB(t)
	for _, cl := range c.Classes() {
		lines := c.classEvidence(cl)
		joined := strings.Join(lines, "\n")
		if cl.Closed {
			if !strings.Contains(joined, "无离类边") {
				t.Errorf("closed class %v: evidence lacks 无离类边:\n%s", cl.States, joined)
			}
			if strings.Contains(joined, "离类边 →") {
				t.Errorf("closed class %v: evidence reports exit edges:\n%s", cl.States, joined)
			}
		} else if !strings.Contains(joined, "离类边 →") {
			t.Errorf("transient class %v: evidence lacks exit edges:\n%s", cl.States, joined)
		}
	}
}

func TestZeroMeanClassPotential(t *testing.T) {
	c := chainD(t)
	u := findClass(c.Classes(), c.Index("U"))
	if u == nil || u.Kind != ClosedZeroReward {
		t.Fatalf("class of U: got %+v, want closed zero-reward", u)
	}
	ratEq(t, u.Stationary[0], "2/3")
	ratEq(t, u.Stationary[1], "1/3")
	ratEq(t, u.Potential[0], "2/3")
	ratEq(t, u.Potential[1], "-4/3")
}
