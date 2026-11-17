package formal

import (
	"math"
	"testing"
)

func TestNormQuantile(t *testing.T) {
	cases := []struct {
		p    float64
		want float64
	}{
		{0.5, 0},
		{0.975, 1.959963984540054},
		{0.995, 2.5758293035489004},
		{0.025, -1.959963984540054},
	}
	for _, tc := range cases {
		got := normQuantile(tc.p)
		if math.Abs(got-tc.want) > 1e-8 {
			t.Errorf("normQuantile(%v) = %v, want %v", tc.p, got, tc.want)
		}
	}
}

func TestMeanVariance(t *testing.T) {
	m, v := meanVariance([]float64{2, 4, 4, 4, 5, 5, 7, 9})
	if m != 5 {
		t.Fatalf("mean = %v, want 5", m)
	}
	if math.Abs(v-32.0/7.0) > 1e-12 {
		t.Fatalf("variance = %v, want %v", v, 32.0/7.0)
	}
}

func TestHarmonicLookBudgetSumsBelowAlpha(t *testing.T) {
	alpha := 0.05
	sum := 0.0
	for look := 1; look <= 1000; look++ {
		sum += alpha / (float64(look) * float64(look+1))
	}
	if sum > alpha {
		t.Fatalf("harmonic budget sum = %v, must not exceed alpha %v", sum, alpha)
	}
	if alpha-sum > 1e-3 {
		t.Fatalf("harmonic budget sum = %v, unexpectedly far below alpha %v", sum, alpha)
	}
}

func TestWeightedAlphaBudgetAcrossMetrics(t *testing.T) {
	engine, err := New(Config{
		Alpha: 0.05,
		Metrics: []MetricSpec{
			{Name: "a", Kind: KindProportion, Direction: HigherIsBetter, MinSamplesPerArm: 2, Weight: 1},
			{Name: "b", Kind: KindProportion, Direction: HigherIsBetter, MinSamplesPerArm: 2, Weight: 3},
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for i := 0; i < 5; i++ {
		for _, metric := range []string{"a", "b"} {
			for _, arm := range []Arm{Control, Treatment} {
				if err := engine.Add(Observation{Metric: metric, Arm: arm, Value: 1}); err != nil {
					t.Fatalf("Add: %v", err)
				}
			}
		}
	}

	total := 0.0
	for look := 0; look < 10; look++ {
		decision := engine.Evaluate()
		var alphaA, alphaB float64
		for _, result := range decision.Metrics {
			total += result.LookAlpha
			switch result.Name {
			case "a":
				alphaA = result.LookAlpha
			case "b":
				alphaB = result.LookAlpha
			}
		}
		if math.Abs(alphaB-3*alphaA) > 1e-15 {
			t.Fatalf("look %d: alpha b/a = %v/%v, want weight ratio 3", look+1, alphaB, alphaA)
		}
	}
	if total > 0.05 {
		t.Fatalf("total spent alpha = %v, exceeds 0.05", total)
	}
}
