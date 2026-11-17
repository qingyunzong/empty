package formal

// eventKind distinguishes the recorded event types.
type eventKind int

const (
	sampleEvent eventKind = iota
	readyEvent
)

// event is one recorded input in arrival order.
type event struct {
	kind   eventKind
	ts     int64
	pod    string
	metric string
	value  int64
	ready  bool
}

// Naive is the reference implementation used to validate Controller. It
// stores every event and, on each Evaluate, rebuilds the complete pod
// state from scratch by replaying the event log in arrival order. Its
// recommendations must match Controller's for any identical event
// stream, including out-of-order samples and non-monotonic evaluation
// times.
type Naive struct {
	eng    engine
	events []event
}

// NewNaive creates a Naive reference for cfg.
func NewNaive(cfg Config) *Naive {
	return &Naive{eng: newEngine(cfg)}
}

// AddSample records a metric value observed at ts for a pod.
func (n *Naive) AddSample(ts int64, pod, metric string, value int64) {
	n.events = append(n.events, event{
		kind:   sampleEvent,
		ts:     ts,
		pod:    pod,
		metric: metric,
		value:  value,
	})
}

// SetPodReady records the latest readiness verdict for a pod.
func (n *Naive) SetPodReady(pod string, ready bool) {
	n.events = append(n.events, event{
		kind:  readyEvent,
		pod:   pod,
		ready: ready,
	})
}

// Evaluate rebuilds state by full event replay and then evaluates.
func (n *Naive) Evaluate(t int64, currentReplicas int32) Recommendation {
	state := newPodState()
	for _, ev := range n.events {
		switch ev.kind {
		case sampleEvent:
			state.addSample(ev.ts, ev.pod, ev.metric, ev.value)
		case readyEvent:
			state.ready[ev.pod] = ev.ready
		}
	}
	n.eng.state = state
	return n.eng.evaluate(t, currentReplicas)
}

// HistoryLen reports how many recommendation entries are retained.
func (n *Naive) HistoryLen() int {
	return len(n.eng.history)
}
