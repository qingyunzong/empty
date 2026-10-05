package monitor

import (
	"math/big"
	"sort"
)

// Op is a single mutation. Delete removes the sample at Sample.Time;
// otherwise the sample is upserted under the version rule.
type Op struct {
	Delete bool
	Sample Sample
}

// upsertInto applies the duplicate-timestamp rule: a strictly higher
// version overwrites the existing sample; equal or lower versions are
// dropped.
func upsertInto(samples []Sample, s Sample) []Sample {
	i := sort.Search(len(samples), func(i int) bool { return samples[i].Time >= s.Time })
	if i < len(samples) && samples[i].Time == s.Time {
		if samples[i].Version >= s.Version {
			return samples
		}
		samples[i] = s.clone()
		return samples
	}
	samples = append(samples, Sample{})
	copy(samples[i+1:], samples[i:])
	samples[i] = s.clone()
	return samples
}

func deleteFrom(samples []Sample, t int64) []Sample {
	i := sort.Search(len(samples), func(i int) bool { return samples[i].Time >= t })
	if i < len(samples) && samples[i].Time == t {
		return append(samples[:i], samples[i+1:]...)
	}
	return samples
}

func applyOps(samples []Sample, ops []Op) []Sample {
	for _, op := range ops {
		if op.Delete {
			samples = deleteFrom(samples, op.Sample.Time)
		} else {
			samples = upsertInto(samples, op.Sample)
		}
	}
	return samples
}

func cloneSamples(samples []Sample) []Sample {
	out := make([]Sample, len(samples))
	for i, s := range samples {
		out[i] = s.clone()
	}
	return out
}

// Model is the reference per-segment integration model: a plain sorted
// sample list whose Integral walks every segment. The persistent Store
// is cross-checked against it.
type Model struct {
	samples []Sample
}

func (m *Model) Apply(ops ...Op) { m.samples = applyOps(m.samples, ops) }

func (m *Model) Samples() []Sample { return cloneSamples(m.samples) }

// Integral sums exact trapezoid contributions segment by segment,
// skipping any segment with a missing endpoint.
func (m *Model) Integral(a, b int64) *big.Rat {
	total := new(big.Rat)
	for i := 0; i+1 < len(m.samples); i++ {
		s1, s2 := m.samples[i], m.samples[i+1]
		if s1.Missing || s2.Missing {
			continue
		}
		total.Add(total, segIntegralClipped(s1.Time, s1.Value, s2.Time, s2.Value, a, b))
	}
	return total
}
