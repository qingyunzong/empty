package formal

import (
	"math/rand"
	"testing"
)

// randomConfig builds a randomized but valid configuration exercising
// windows, rate policies and replica boundaries.
func randomConfig(rng *rand.Rand) Config {
	minR := int32(rng.Intn(4))
	cfg := Config{
		MinReplicas: minR,
		MaxReplicas: minR + 1 + int32(rng.Intn(30)),
	}
	metrics := []string{"cpu", "mem", "qps"}
	rng.Shuffle(len(metrics), func(i, j int) { metrics[i], metrics[j] = metrics[j], metrics[i] })
	for _, name := range metrics[:1+rng.Intn(3)] {
		cfg.Metrics = append(cfg.Metrics, MetricSpec{
			Name:   name,
			Target: 1 + int64(rng.Intn(500)),
		})
	}
	cfg.ScaleUp = randomRules(rng)
	cfg.ScaleDown = randomRules(rng)
	return cfg
}

func randomRules(rng *rand.Rand) ScalingRules {
	rules := ScalingRules{
		StabilizationWindowSeconds: int64(rng.Intn(200)),
	}
	switch rng.Intn(10) {
	case 0:
		rules.SelectPolicy = DisabledSelect
	case 1, 2:
		rules.SelectPolicy = MinSelect
	default:
		rules.SelectPolicy = MaxSelect
	}
	for i := 0; i < rng.Intn(3); i++ {
		p := ScalingPolicy{
			Value:         1 + int32(rng.Intn(10)),
			PeriodSeconds: int64(1 + rng.Intn(60)),
		}
		if rng.Intn(2) == 0 {
			p.Type = PodsPolicy
		} else {
			p.Type = PercentPolicy
			p.Value = 1 + int32(rng.Intn(200))
		}
		rules.Policies = append(rules.Policies, p)
	}
	return rules
}

// TestNaiveReplayConsistency feeds identical randomized event streams —
// out-of-order samples, readiness flips, non-monotonic evaluation times
// and replica counts outside the configured bounds — into Controller and
// Naive, and requires identical recommendations and history lengths.
func TestNaiveReplayConsistency(t *testing.T) {
	pods := []string{"alpha", "beta", "gamma", "delta"}
	metricNames := []string{"cpu", "mem", "qps"}

	for seed := int64(0); seed < 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		cfg := randomConfig(rng)
		controller := NewController(cfg)
		naive := NewNaive(cfg)

		evalT := int64(1000)
		for step := 0; step < 200; step++ {
			switch rng.Intn(10) {
			case 0, 1, 2, 3, 4: // sample, possibly out of order
				ts := evalT + int64(rng.Intn(201)) - 100
				pod := pods[rng.Intn(len(pods))]
				metric := metricNames[rng.Intn(len(metricNames))]
				value := int64(rng.Intn(2001))
				controller.AddSample(ts, pod, metric, value)
				naive.AddSample(ts, pod, metric, value)
			case 5, 6: // readiness flip
				pod := pods[rng.Intn(len(pods))]
				ready := rng.Intn(4) != 0
				controller.SetPodReady(pod, ready)
				naive.SetPodReady(pod, ready)
			default: // evaluate, possibly jumping back in time
				evalT += int64(rng.Intn(121)) - 40
				current := int32(rng.Intn(int(cfg.MaxReplicas) + 6))
				got := controller.Evaluate(evalT, current)
				want := naive.Evaluate(evalT, current)
				if got != want {
					t.Fatalf("seed=%d step=%d t=%d current=%d cfg=%+v:\ncontroller=%+v\nnaive     =%+v",
						seed, step, evalT, current, cfg, got, want)
				}
				if controller.HistoryLen() != naive.HistoryLen() {
					t.Fatalf("seed=%d step=%d: history len %d != %d",
						seed, step, controller.HistoryLen(), naive.HistoryLen())
				}
			}
		}
	}
}

// TestNaiveReplayDeterministicRerun replays one recorded tricky stream
// with large forward and backward time jumps through both
// implementations.
func TestNaiveReplayDeterministicRerun(t *testing.T) {
	cfg := Config{
		MinReplicas: 1,
		MaxReplicas: 8,
		Metrics:     []MetricSpec{{Name: "cpu", Target: 50}},
		ScaleUp: ScalingRules{
			StabilizationWindowSeconds: 30,
			Policies:                   []ScalingPolicy{{Type: PercentPolicy, Value: 50, PeriodSeconds: 10}},
		},
		ScaleDown: ScalingRules{
			StabilizationWindowSeconds: 120,
			Policies:                   []ScalingPolicy{{Type: PodsPolicy, Value: 2, PeriodSeconds: 10}},
		},
	}
	c := NewController(cfg)
	n := NewNaive(cfg)

	type call struct {
		op    string
		ts    int64
		pod   string
		value int64
		ready bool
		cur   int32
	}
	stream := []call{
		{op: "sample", ts: 500, pod: "a", value: 100},
		{op: "sample", ts: 400, pod: "a", value: 900}, // out of order, must lose
		{op: "eval", ts: 500, cur: 4},
		{op: "sample", ts: 600, pod: "b", value: 300},
		{op: "ready", pod: "b", ready: false},
		{op: "eval", ts: 2000, cur: 4}, // big jump forward
		{op: "eval", ts: 550, cur: 3},  // jump back
		{op: "ready", pod: "b", ready: true},
		{op: "eval", ts: 540, cur: 8}, // further back, at the boundary
		{op: "eval", ts: 100000, cur: 1},
		{op: "eval", ts: 0, cur: 0}, // jump to zero replicas and time
	}
	for i, op := range stream {
		switch op.op {
		case "sample":
			c.AddSample(op.ts, op.pod, "cpu", op.value)
			n.AddSample(op.ts, op.pod, "cpu", op.value)
		case "ready":
			c.SetPodReady(op.pod, op.ready)
			n.SetPodReady(op.pod, op.ready)
		case "eval":
			got := c.Evaluate(op.ts, op.cur)
			want := n.Evaluate(op.ts, op.cur)
			if got != want {
				t.Fatalf("step %d (%+v): controller=%+v naive=%+v", i, op, got, want)
			}
		}
	}
}
