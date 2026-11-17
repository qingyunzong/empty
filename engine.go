package formal

// sampleKey identifies one metric stream of one pod.
type sampleKey struct {
	pod    string
	metric string
}

// sample is the freshest value observed for a stream. Out-of-order
// deliveries never replace a newer timestamp; equal timestamps are
// resolved in favour of the later arrival.
type sample struct {
	value int64
	ts    int64
}

// podState is the aggregated view of every event processed so far.
type podState struct {
	// ready holds the last readiness verdict per pod. Pods never
	// mentioned by a readiness event are assumed ready.
	ready map[string]bool
	// samples holds the freshest sample per (pod, metric).
	samples map[sampleKey]sample
}

func newPodState() podState {
	return podState{
		ready:   make(map[string]bool),
		samples: make(map[sampleKey]sample),
	}
}

func (s podState) isReady(pod string) bool {
	ready, known := s.ready[pod]
	return !known || ready
}

// addSample keeps the sample with the largest timestamp; ties are won by
// the most recent arrival, so replays in arrival order stay deterministic.
func (s podState) addSample(ts int64, pod, metric string, value int64) {
	key := sampleKey{pod: pod, metric: metric}
	if existing, ok := s.samples[key]; ok && existing.ts > ts {
		return
	}
	s.samples[key] = sample{value: value, ts: ts}
}

// recEntry is one recorded raw recommendation.
type recEntry struct {
	ts       int64
	replicas int32
}

// engine evaluates recommendations from a podState. Controller maintains
// the state incrementally while Naive rebuilds it by replaying events;
// both share this code so their verdicts are comparable.
type engine struct {
	cfg   Config
	state podState

	// history holds raw recommendations not yet evicted. An entry is
	// evicted exactly when its age exceeds the larger stabilization
	// window, i.e. entries with t-ts <= maxWindow are kept.
	history []recEntry

	lastEvalT   int64
	hasLastEval bool
}

func newEngine(cfg Config) engine {
	return engine{cfg: cfg, state: newPodState()}
}

// evaluate runs the full pipeline: metric aggregation, history recording
// with precise eviction, stabilization, rate limiting and clamping.
func (e *engine) evaluate(t int64, current int32) Recommendation {
	desired := e.metricDesired(current)
	e.history = append(e.history, recEntry{ts: t, replicas: desired})
	e.evict(t)
	stabilized := e.stabilize(t, desired, current)
	limited := e.applyRateLimits(t, stabilized, current)
	replicas := clampInt32(int64(limited), int64(e.cfg.MinReplicas), int64(e.cfg.MaxReplicas))
	e.lastEvalT = t
	e.hasLastEval = true
	return Recommendation{
		Replicas:   replicas,
		Stabilized: stabilized,
		Desired:    desired,
		Timestamp:  t,
	}
}

// metricDesired computes ceil(current * sum / (count * target)) per metric
// over ready pods that report the metric, and returns the largest value.
// Pods without a sample for a metric and unready pods are excluded from
// that metric entirely. When no metric has any data the current replica
// count is returned unchanged.
func (e *engine) metricDesired(current int32) int32 {
	best := int64(-1)
	for _, m := range e.cfg.Metrics {
		if m.Target <= 0 {
			continue
		}
		var sum, count int64
		for key, s := range e.state.samples {
			if key.metric != m.Name || !e.state.isReady(key.pod) {
				continue
			}
			sum += s.value
			count++
		}
		if count == 0 {
			continue
		}
		if d := ceilDiv(int64(current)*sum, count*m.Target); d > best {
			best = d
		}
	}
	if best < 0 {
		return current
	}
	return clampInt32(best, 0, int64(^uint32(0)>>1))
}

// evict drops history entries whose age at time t exceeds the largest
// configured stabilization window. The boundary is exact: an entry with
// age == maxWindow is still eligible and kept.
func (e *engine) evict(t int64) {
	maxWindow := e.cfg.ScaleUp.StabilizationWindowSeconds
	if w := e.cfg.ScaleDown.StabilizationWindowSeconds; w > maxWindow {
		maxWindow = w
	}
	kept := e.history[:0]
	for _, h := range e.history {
		if t-h.ts <= maxWindow {
			kept = append(kept, h)
		}
	}
	e.history = kept
}

// stabilize picks the most conservative recommendation inside the
// direction's window: the minimum when scaling up, the maximum when
// scaling down. An entry is eligible while t-ts <= window.
func (e *engine) stabilize(t int64, desired, current int32) int32 {
	var window int64
	switch {
	case desired > current:
		window = e.cfg.ScaleUp.StabilizationWindowSeconds
	case desired < current:
		window = e.cfg.ScaleDown.StabilizationWindowSeconds
	default:
		return desired
	}
	result := desired
	for _, h := range e.history {
		if t-h.ts > window {
			continue
		}
		if desired > current {
			if h.replicas < result {
				result = h.replicas
			}
		} else if h.replicas > result {
			result = h.replicas
		}
	}
	return result
}

// applyRateLimits bounds the step from current to stabilized by the
// direction's scaling policies. Each policy's allowance is prorated by
// the time elapsed since the previous evaluation; the first evaluation
// is granted a full period. A backwards or zero time jump yields no new
// allowance.
func (e *engine) applyRateLimits(t int64, stabilized, current int32) int32 {
	if stabilized == current {
		return current
	}
	up := stabilized > current
	rules := e.cfg.ScaleDown
	if up {
		rules = e.cfg.ScaleUp
	}
	if rules.SelectPolicy == DisabledSelect {
		return current
	}
	if len(rules.Policies) == 0 {
		return stabilized
	}
	allowed := int64(-1)
	for _, p := range rules.Policies {
		a := policyAllowance(p, current, e.elapsed(t, p))
		if allowed < 0 ||
			(rules.SelectPolicy == MinSelect && a < allowed) ||
			(rules.SelectPolicy != MinSelect && a > allowed) {
			allowed = a
		}
	}
	cur := int64(current)
	if up {
		return clampInt32(minInt64(int64(stabilized), cur+allowed), 0, int64(^uint32(0)>>1))
	}
	return clampInt32(maxInt64(int64(stabilized), cur-allowed), 0, int64(^uint32(0)>>1))
}

// elapsed returns the time since the previous evaluation, clamped to
// zero for backwards time jumps. The first evaluation is credited a
// full policy period.
func (e *engine) elapsed(t int64, p ScalingPolicy) int64 {
	if !e.hasLastEval {
		return p.PeriodSeconds
	}
	if d := t - e.lastEvalT; d > 0 {
		return d
	}
	return 0
}

// policyAllowance converts a policy into a pod allowance prorated by
// elapsed/PeriodSeconds.
func policyAllowance(p ScalingPolicy, current int32, elapsed int64) int64 {
	base := int64(p.Value)
	if p.Type == PercentPolicy {
		base = ceilDiv(int64(current)*int64(p.Value), 100)
	}
	if base < 0 {
		base = 0
	}
	if p.PeriodSeconds <= 0 {
		return base
	}
	return base * elapsed / p.PeriodSeconds
}

func ceilDiv(a, b int64) int64 {
	if a <= 0 {
		return 0
	}
	return (a + b - 1) / b
}

func clampInt32(v, lo, hi int64) int32 {
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	return int32(v)
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
