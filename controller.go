package formal

// Controller is the incremental autoscaler aggregator intended for HPA
// extender calls. It maintains pod and metric state as events stream in
// and answers Evaluate in O(metrics x streams + history).
//
// Semantics:
//   - Samples may arrive out of order; per (pod, metric) only the newest
//     timestamp counts, ties resolved by arrival order.
//   - Pods are ready unless a SetPodReady event says otherwise; the
//     latest readiness event wins.
//   - Unready pods and pods missing a metric are excluded from that
//     metric's aggregation.
//   - Scale up and scale down use independent stabilization windows;
//     scale down takes the most conservative (largest) recommendation in
//     its window, scale up the smallest.
//   - Recommendation history is evicted precisely once an entry's age
//     exceeds the largest configured window.
type Controller struct {
	eng engine
}

// NewController creates a Controller for cfg.
func NewController(cfg Config) *Controller {
	return &Controller{eng: newEngine(cfg)}
}

// AddSample records a metric value observed at ts for a pod.
func (c *Controller) AddSample(ts int64, pod, metric string, value int64) {
	c.eng.state.addSample(ts, pod, metric, value)
}

// SetPodReady records the latest readiness verdict for a pod.
func (c *Controller) SetPodReady(pod string, ready bool) {
	c.eng.state.ready[pod] = ready
}

// Evaluate computes the recommendation for time t given the current
// replica count.
func (c *Controller) Evaluate(t int64, currentReplicas int32) Recommendation {
	return c.eng.evaluate(t, currentReplicas)
}

// HistoryLen reports how many recommendation entries are retained. It is
// exported mainly so tests and diagnostics can observe precise eviction.
func (c *Controller) HistoryLen() int {
	return len(c.eng.history)
}
