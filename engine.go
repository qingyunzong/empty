package formal

import (
	"fmt"
	"math"
	"sync"
)

const defaultMinSamples = 2

var defaultTrafficSteps = []float64{1, 5, 10, 25, 50, 100}

type location struct {
	arm Arm
	idx int
}

type observationKey struct {
	metric string
	id     string
}

type metricState struct {
	spec       MetricSpec
	minSamples int
	maxSamples int
	alpha      float64
	control    []float64
	treatment  []float64
	ids        map[string]location
	looks      int
}

// Engine is a concurrency-safe progressive-delivery controller. It is
// deterministic: observations, looks, and actions are the only inputs.
type Engine struct {
	mu           sync.Mutex
	metrics      []*metricState
	byName       map[string]*metricState
	traffic      []float64
	step         int
	rolledBack   bool
	rollbackLook int
	history      []Decision
}

// Controller is an alias for Engine.
type Controller = Engine

// New validates cfg and builds an empty controller.
func New(cfg Config) (*Engine, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	traffic := append([]float64(nil), cfg.TrafficSteps...)
	if len(traffic) == 0 {
		traffic = append([]float64(nil), defaultTrafficSteps...)
	}

	totalWeight := 0.0
	weights := make([]float64, len(cfg.Metrics))
	for i, m := range cfg.Metrics {
		w := m.Weight
		if w == 0 {
			w = 1
		}
		weights[i] = w
		totalWeight += w
	}

	e := &Engine{
		traffic: traffic,
		byName:  make(map[string]*metricState, len(cfg.Metrics)),
	}
	for i, spec := range cfg.Metrics {
		minSamples := spec.MinSamplesPerArm
		if minSamples == 0 {
			minSamples = cfg.MinSamplesPerArm
		}
		if minSamples == 0 {
			minSamples = defaultMinSamples
		}
		state := &metricState{
			spec:       spec,
			minSamples: minSamples,
			maxSamples: spec.MaxSamplesPerArm,
			alpha:      cfg.Alpha * weights[i] / totalWeight,
			ids:        make(map[string]location),
		}
		e.metrics = append(e.metrics, state)
		e.byName[spec.Name] = state
	}
	return e, nil
}

// NewController is an alias for New.
func NewController(cfg Config) (*Controller, error) {
	return New(cfg)
}

// Add ingests one observation. Non-empty IDs are upserts scoped to a metric, so
// replaying a corrected delayed sample replaces rather than duplicates it.
func (e *Engine) Add(obs Observation) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.validateObservationLocked(obs, make(map[observationKey]Arm, 1)); err != nil {
		return err
	}
	e.applyObservationLocked(obs)
	return nil
}

// Observe is an alias for Add.
func (e *Engine) Observe(obs Observation) error {
	return e.Add(obs)
}

// AddBatch applies observations atomically: if any observation is invalid,
// none are stored. Duplicate IDs in the batch follow last-write-wins semantics.
func (e *Engine) AddBatch(observations []Observation) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	pending := make(map[observationKey]Arm, len(observations))
	for _, obs := range observations {
		if err := e.validateObservationLocked(obs, pending); err != nil {
			return err
		}
	}
	for _, obs := range observations {
		e.applyObservationLocked(obs)
	}
	return nil
}

// Backfill upserts delayed or corrected samples and is equivalent to AddBatch.
// A later Evaluate recomputes every statistic from the complete retained data.
// It never changes an already executed rollback.
func (e *Engine) Backfill(observations ...Observation) error {
	return e.AddBatch(observations)
}

// Samples returns the retained sample counts for a metric.
func (e *Engine) Samples(metric string) (control, treatment int, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	state, ok := e.byName[metric]
	if !ok {
		return 0, 0, fmt.Errorf("%w: %q", ErrUnknownMetric, metric)
	}
	return len(state.control), len(state.treatment), nil
}

func (e *Engine) validateObservationLocked(obs Observation, batch map[observationKey]Arm) error {
	state, ok := e.byName[obs.Metric]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMetric, obs.Metric)
	}
	if !obs.Arm.Valid() {
		return fmt.Errorf("%w: %q", ErrInvalidArm, obs.Arm)
	}
	if math.IsNaN(obs.Value) || math.IsInf(obs.Value, 0) {
		return fmt.Errorf("%w: metric %q got %v", ErrInvalidValue, obs.Metric, obs.Value)
	}
	if state.spec.Kind == KindProportion && obs.Value != 0 && obs.Value != 1 {
		return fmt.Errorf("%w: proportion metric %q got %v (want 0 or 1)", ErrInvalidValue, obs.Metric, obs.Value)
	}
	if obs.ID == "" {
		return nil
	}
	if loc, exists := state.ids[obs.ID]; exists && loc.arm != obs.Arm {
		return fmt.Errorf("%w: id %q already belongs to arm %q", ErrInvalidArm, obs.ID, loc.arm)
	}
	if batch != nil {
		key := observationKey{metric: obs.Metric, id: obs.ID}
		if arm, exists := batch[key]; exists && arm != obs.Arm {
			return fmt.Errorf("%w: id %q changes arm within one batch", ErrInvalidArm, obs.ID)
		}
		batch[key] = obs.Arm
	}
	return nil
}

func (e *Engine) applyObservationLocked(obs Observation) {
	state := e.byName[obs.Metric]
	if obs.ID != "" {
		if loc, exists := state.ids[obs.ID]; exists {
			state.setValue(loc, obs.Value)
			return
		}
	}
	loc := state.appendValue(obs.Arm, obs.Value)
	if obs.ID != "" {
		state.ids[obs.ID] = loc
	}
}

func (m *metricState) appendValue(arm Arm, value float64) location {
	if arm == Control {
		m.control = append(m.control, value)
		return location{arm: Control, idx: len(m.control) - 1}
	}
	m.treatment = append(m.treatment, value)
	return location{arm: Treatment, idx: len(m.treatment) - 1}
}

func (m *metricState) setValue(loc location, value float64) {
	if loc.arm == Control {
		m.control[loc.idx] = value
		return
	}
	m.treatment[loc.idx] = value
}

// Evaluate recomputes statistics from the full retained sample set and returns
// the current recommendation. It consumes one look of this metric's alpha
// budget when the metric has reached its minimum sample size. Evaluate does not
// execute the action; call Execute (or Step) for that.
func (e *Engine) Evaluate() Decision {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.evaluateLocked()
}

// Step evaluates and executes the recommended action atomically. In
// particular, a rollback recommended by this call becomes irreversible.
func (e *Engine) Step() (Decision, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	decision := e.evaluateLocked()
	if err := e.executeLocked(decision.Action); err != nil {
		return decision, err
	}
	return decision, nil
}

func (e *Engine) evaluateLocked() Decision {
	decision := Decision{
		Action:         Hold,
		TrafficPercent: e.trafficPercentLocked(),
	}
	advanceLooks := !e.rolledBack
	allReady := true
	allAtMax := true

	for _, state := range e.metrics {
		result := evaluateMetric(state, advanceLooks)
		decision.Metrics = append(decision.Metrics, result)
		if result.Look > decision.Look {
			decision.Look = result.Look
		}
		if !result.Ready {
			allReady = false
			decision.PendingMetrics = append(decision.PendingMetrics, result.Name)
		}
		if !result.AtMaxSamples {
			allAtMax = false
		}
		if result.Regressed {
			decision.HarmfulMetrics = append(decision.HarmfulMetrics, result.Name)
		}
		if result.Improved {
			decision.HelpfulMetrics = append(decision.HelpfulMetrics, result.Name)
		}
	}

	decision.Final = allAtMax
	if e.rolledBack {
		decision.Action = Rollback
		decision.Reason = "rollback already executed; the decision is locked"
		decision.Locked = true
		decision.RollbackExecuted = true
		decision.Final = true
		decision.NextTrafficPercent = 0
		e.history = append(e.history, cloneDecision(decision))
		return decision
	}

	decision.NextTrafficPercent = decision.TrafficPercent
	switch {
	case len(decision.HarmfulMetrics) > 0:
		decision.Action = Rollback
		decision.NextTrafficPercent = 0
		decision.Reason = "significant regression detected; roll back treatment traffic"
	case !allReady:
		decision.Action = Hold
		decision.Reason = "waiting for the configured minimum samples per arm"
	case len(decision.HelpfulMetrics) > 0 && e.step < len(e.traffic)-1:
		decision.Action = ScaleUp
		decision.NextTrafficPercent = e.traffic[e.step+1]
		decision.Reason = "significant improvement detected; increase treatment traffic"
	case len(decision.HelpfulMetrics) > 0:
		decision.Action = Hold
		decision.Reason = "significant improvement detected, but treatment is already at maximum traffic"
	case allAtMax:
		decision.Action = Hold
		decision.Reason = "maximum planned samples reached without a significant difference; hold"
	default:
		decision.Action = Hold
		decision.Reason = "no significant difference at this look; hold"
	}
	e.history = append(e.history, cloneDecision(decision))
	return decision
}

func evaluateMetric(state *metricState, advance bool) MetricResult {
	result := MetricResult{
		Name:       state.spec.Name,
		Kind:       state.spec.Kind,
		Direction:  state.spec.Direction,
		ControlN:   len(state.control),
		TreatmentN: len(state.treatment),
	}
	result.ControlMean, result.TreatmentMean = mean(state.control), mean(state.treatment)
	result.Difference = result.TreatmentMean - result.ControlMean
	result.Ready = result.ControlN >= state.minSamples && result.TreatmentN >= state.minSamples
	result.AtMaxSamples = state.maxSamples > 0 &&
		result.ControlN >= state.maxSamples && result.TreatmentN >= state.maxSamples

	if result.Ready && advance {
		state.looks++
	}
	result.Look = state.looks
	if result.Look > 0 {
		// Harmonic look budget: sum over k >= 1 of 1/(k(k+1)) is exactly 1.
		k := float64(result.Look)
		result.LookAlpha = state.alpha / (k * (k + 1))
		result.CriticalValue = normQuantile(1 - result.LookAlpha/2)
	}

	if result.ControlN == 0 || result.TreatmentN == 0 {
		return result
	}
	result.ZScore = metricZ(state, result.ControlMean, result.TreatmentMean)
	if result.Look == 0 {
		return result
	}
	result.Significant = math.Abs(result.ZScore) >= result.CriticalValue
	if !result.Significant {
		return result
	}
	increased := result.ZScore > 0
	improved := increased
	if state.spec.Direction == LowerIsBetter {
		improved = !increased
	}
	result.Improved = improved
	result.Regressed = !improved
	return result
}

func metricZ(state *metricState, controlMean, treatmentMean float64) float64 {
	diff := treatmentMean - controlMean
	var se float64
	switch state.spec.Kind {
	case KindProportion:
		n0, n1 := float64(len(state.control)), float64(len(state.treatment))
		// Pooled variance is the standard two-proportion z test and remains
		// well defined when one arm contains only zeros or only ones.
		p := (controlMean*n0 + treatmentMean*n1) / (n0 + n1)
		p = math.Max(0, math.Min(1, p))
		se = math.Sqrt(p * (1 - p) * (1/n0 + 1/n1))
	default:
		_, v0 := meanVariance(state.control)
		_, v1 := meanVariance(state.treatment)
		se = math.Sqrt(v0/float64(len(state.control)) + v1/float64(len(state.treatment)))
	}
	switch {
	case se > 0:
		return diff / se
	case diff > 0:
		return math.MaxFloat64
	case diff < 0:
		return -math.MaxFloat64
	default:
		return 0
	}
}

// Execute records the action the orchestrator actually applied. ScaleUp moves
// one traffic step and is a no-op at the last step. Rollback is terminal:
// later backfill and recomputation may update statistics, but the returned
// action remains Rollback and ScaleUp returns ErrRollbackLocked.
func (e *Engine) Execute(action Action) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.executeLocked(action)
}

func (e *Engine) executeLocked(action Action) error {
	switch action {
	case Hold:
		return nil
	case Rollback:
		if !e.rolledBack {
			e.rolledBack = true
			e.rollbackLook = e.maxLookLocked()
		}
		return nil
	case ScaleUp:
		if e.rolledBack {
			return ErrRollbackLocked
		}
		if e.step < len(e.traffic)-1 {
			e.step++
		}
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrInvalidAction, action)
	}
}

// RollbackExecuted reports whether a rollback has been executed.
func (e *Engine) RollbackExecuted() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rolledBack
}

// RollbackLook returns the look at which rollback was executed.
func (e *Engine) RollbackLook() (look int, ok bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rollbackLook, e.rolledBack
}

// TrafficPercent returns the current treatment traffic. It is zero after an
// executed rollback.
func (e *Engine) TrafficPercent() float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.trafficPercentLocked()
}

func (e *Engine) trafficPercentLocked() float64 {
	if e.rolledBack {
		return 0
	}
	return e.traffic[e.step]
}

func (e *Engine) maxLookLocked() int {
	maxLook := 0
	for _, state := range e.metrics {
		if state.looks > maxLook {
			maxLook = state.looks
		}
	}
	return maxLook
}

// History returns a copy of every decision returned so far. It includes looks
// computed after an executed rollback.
func (e *Engine) History() []Decision {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Decision, len(e.history))
	for i, d := range e.history {
		out[i] = cloneDecision(d)
	}
	return out
}

func cloneDecision(d Decision) Decision {
	d.PendingMetrics = append([]string(nil), d.PendingMetrics...)
	d.HelpfulMetrics = append([]string(nil), d.HelpfulMetrics...)
	d.HarmfulMetrics = append([]string(nil), d.HarmfulMetrics...)
	d.Metrics = append([]MetricResult(nil), d.Metrics...)
	return d
}
