package formal

import (
	"fmt"
	"sort"
	"testing"
	"time"
)

type podPhase uint8

const (
	podStarting podPhase = iota
	podReady
	podUnready
	podTerminating
)

type simPod struct {
	phase    podPhase
	readyAt  time.Duration
	deadline time.Duration
}

type simConfig struct {
	policy              Policy
	initialReady        int
	capacity            int
	step                time.Duration
	duration            time.Duration
	capacityChanges     map[time.Duration]int
	flaps               map[time.Duration]int
	evictOnCapacityDrop bool
	checkObservedBounds bool
	expectConverged     bool
}

type simSnapshot struct {
	at          time.Duration
	total       int
	available   int
	terminating int
	capacity    int
}

type terminationSim struct {
	t        *testing.T
	cfg      simConfig
	planner  *Planner
	pods     []simPod
	now      time.Duration
	capacity int

	snapshots  []simSnapshot
	decisions  []Decision
	batches    map[uint64]TerminationBatch
	violations []string
}

func newTerminationSim(t *testing.T, cfg simConfig) *terminationSim {
	t.Helper()
	if cfg.step <= 0 {
		cfg.step = time.Second
	}
	planner, err := NewPlanner(cfg.policy)
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	pods := make([]simPod, cfg.initialReady)
	for i := range pods {
		pods[i].phase = podReady
	}
	return &terminationSim{
		t:        t,
		cfg:      cfg,
		planner:  planner,
		pods:     pods,
		capacity: cfg.capacity,
		batches:  make(map[uint64]TerminationBatch),
	}
}

func (s *terminationSim) run() {
	s.t.Helper()
	if s.cfg.duration < s.cfg.step {
		s.t.Fatalf("simulation duration %s is shorter than step %s", s.cfg.duration, s.cfg.step)
	}
	for s.now = 0; s.now <= s.cfg.duration; s.now += s.cfg.step {
		s.advanceEvents()
		snapshot := s.snapshot()
		s.snapshots = append(s.snapshots, snapshot)

		if s.cfg.checkObservedBounds {
			bounds := s.planner.Bounds()
			if !bounds.AvailableInBounds(snapshot.available) {
				s.t.Fatalf("t=%s available %d outside [%d,%d]",
					s.now, snapshot.available, bounds.MinAvailable, bounds.MaxTotal)
			}
		}

		decision, err := s.planner.Step(snapshot.observation())
		if err != nil {
			s.t.Fatalf("t=%s Step() error = %v", s.now, err)
		}
		s.decisions = append(s.decisions, decision)
		s.checkDecision(decision)
		s.checkLedger(decision)
		s.applyAction(decision.Action)
	}

	if len(s.violations) != 0 {
		for _, violation := range s.violations {
			s.t.Errorf("%s", violation)
		}
	}
	if s.cfg.expectConverged {
		last := s.decisions[len(s.decisions)-1]
		if !last.Converged {
			s.t.Fatalf("did not converge: t=%s total=%d available=%d terminating=%d target=%d action=%+v pending=%+v",
				last.At, last.Observation.Total, last.Observation.Available,
				last.Observation.Terminating, last.TargetTotal, last.Action,
				last.PendingTerminations)
		}
		if len(last.PendingTerminations) != 0 {
			s.t.Fatalf("converged with pending terminations: %+v", last.PendingTerminations)
		}
		bounds := s.planner.Bounds()
		if last.Feasible && !bounds.AvailableInBounds(last.Observation.Available) {
			s.t.Fatalf("converged outside availability bounds: available=%d bounds=[%d,%d]",
				last.Observation.Available, bounds.MinAvailable, bounds.MaxTotal)
		}
	}
}

func (s *terminationSim) advanceEvents() {
	if capacity, ok := s.cfg.capacityChanges[s.now]; ok {
		s.capacity = capacity
	}

	for i := range s.pods {
		pod := &s.pods[i]
		if (pod.phase == podStarting || pod.phase == podUnready) && pod.readyAt <= s.now {
			pod.phase = podReady
		}
	}

	remaining := s.pods[:0]
	for _, pod := range s.pods {
		if pod.phase == podTerminating && pod.deadline <= s.now {
			continue
		}
		remaining = append(remaining, pod)
	}
	s.pods = remaining

	if count := s.cfg.flaps[s.now]; count > 0 {
		for i := range s.pods {
			if count == 0 {
				break
			}
			if s.pods[i].phase != podReady {
				continue
			}
			s.pods[i].phase = podUnready
			s.pods[i].readyAt = s.now + s.cfg.policy.ReadinessDelay
			count--
		}
	}

	if s.cfg.evictOnCapacityDrop {
		s.enforceCapacity()
	}
}

func (s *terminationSim) enforceCapacity() {
	for s.total() > s.capacity {
		index := -1
		for i := range s.pods {
			if s.pods[i].phase == podStarting || s.pods[i].phase == podUnready {
				index = i
				break
			}
		}
		if index < 0 {
			for i := range s.pods {
				if s.pods[i].phase == podReady {
					index = i
					break
				}
			}
		}
		if index < 0 {
			for i := range s.pods {
				if s.pods[i].phase == podTerminating {
					index = i
					break
				}
			}
		}
		if index < 0 {
			return
		}
		s.pods = append(s.pods[:index], s.pods[index+1:]...)
	}
}

func (s *terminationSim) total() int {
	return len(s.pods)
}

func (s *terminationSim) available() int {
	count := 0
	for _, pod := range s.pods {
		if pod.phase == podReady {
			count++
		}
	}
	return count
}

func (s *terminationSim) terminating() int {
	count := 0
	for _, pod := range s.pods {
		if pod.phase == podTerminating {
			count++
		}
	}
	return count
}

func (s *terminationSim) snapshot() simSnapshot {
	return simSnapshot{
		at:          s.now,
		total:       s.total(),
		available:   s.available(),
		terminating: s.terminating(),
		capacity:    s.capacity,
	}
}

func (s simSnapshot) observation() Observation {
	return Observation{
		Now:         s.at,
		Total:       s.total,
		Available:   s.available,
		Terminating: s.terminating,
		Capacity:    s.capacity,
	}
}

func (s *terminationSim) checkDecision(decision Decision) {
	s.t.Helper()
	observation := decision.Observation
	bounds := s.planner.Bounds()
	action := decision.Action

	if decision.At != s.now {
		s.fail("decision time %s does not match simulation time %s", decision.At, s.now)
	}
	if decision.ProjectedAvailable > bounds.MaxTotal {
		s.fail("t=%s projected available %d exceeds max total %d",
			s.now, decision.ProjectedAvailable, bounds.MaxTotal)
	}
	if observation.Available > bounds.MaxTotal {
		s.fail("t=%s observed available %d exceeds max total %d",
			s.now, observation.Available, bounds.MaxTotal)
	}

	switch action.Kind {
	case ActionScaleUp:
		if action.Replicas <= 0 {
			s.fail("t=%s scale-up with %d replicas", s.now, action.Replicas)
		}
		if action.TerminateReady != 0 || action.TerminateUnready != 0 {
			s.fail("t=%s scale-up carries termination counts: %+v", s.now, action)
		}
		if decision.ProjectedTotal != observation.Total+action.Replicas {
			s.fail("t=%s scale-up projection total=%d, want %d",
				s.now, decision.ProjectedTotal, observation.Total+action.Replicas)
		}
		if decision.ProjectedTotal > decision.MaxTotal {
			s.fail("t=%s scale-up projects total %d above effective max %d",
				s.now, decision.ProjectedTotal, decision.MaxTotal)
		}
		if action.ReadyAt != s.now+s.cfg.policy.ReadinessDelay {
			s.fail("t=%s ReadyAt=%s, want %s", s.now, action.ReadyAt, s.now+s.cfg.policy.ReadinessDelay)
		}
	case ActionScaleDown:
		if action.Replicas <= 0 {
			s.fail("t=%s scale-down with %d replicas", s.now, action.Replicas)
		}
		if action.TerminateUnready+action.TerminateReady != action.Replicas {
			s.fail("t=%s termination split %d+%d != %d",
				s.now, action.TerminateUnready, action.TerminateReady, action.Replicas)
		}
		if action.TerminateUnready > observation.Unready() {
			s.fail("t=%s terminates %d unready pods but only %d exist",
				s.now, action.TerminateUnready, observation.Unready())
		}
		if action.TerminateReady > observation.Available {
			s.fail("t=%s terminates %d ready pods but only %d exist",
				s.now, action.TerminateReady, observation.Available)
		}
		if decision.ProjectedAvailable != observation.Available-action.TerminateReady {
			s.fail("t=%s projected available=%d, want %d",
				s.now, decision.ProjectedAvailable, observation.Available-action.TerminateReady)
		}
		if observation.Available >= bounds.MinAvailable && decision.ProjectedAvailable < bounds.MinAvailable {
			s.fail("t=%s action pushed availability from %d below floor %d",
				s.now, observation.Available, bounds.MinAvailable)
		}
		if observation.Available < bounds.MinAvailable && decision.ProjectedAvailable < observation.Available {
			s.fail("t=%s action worsened an already-low availability from %d to %d",
				s.now, observation.Available, decision.ProjectedAvailable)
		}
		if action.CompleteBy != s.now+s.cfg.policy.TerminationGrace {
			s.fail("t=%s CompleteBy=%s, want %s", s.now, action.CompleteBy, s.now+s.cfg.policy.TerminationGrace)
		}
	case ActionNone:
		if action.Replicas != 0 {
			s.fail("t=%s no-op carries %d replicas", s.now, action.Replicas)
		}
	default:
		s.fail("t=%s unknown action kind %q", s.now, action.Kind)
	}
}

func (s *terminationSim) checkLedger(decision Decision) {
	s.t.Helper()
	current := make(map[uint64]TerminationBatch, len(decision.PendingTerminations))
	for _, batch := range decision.PendingTerminations {
		current[batch.ID] = batch
		if existing, ok := s.batches[batch.ID]; ok {
			if existing != batch {
				s.fail("t=%s termination batch %d changed: before %+v after %+v",
					s.now, batch.ID, existing, batch)
			}
			continue
		}
		if batch.StartedAt != s.now {
			s.fail("t=%s new termination batch %d started at %s", s.now, batch.ID, batch.StartedAt)
		}
		s.batches[batch.ID] = batch
	}

	for id, batch := range s.batches {
		if _, ok := current[id]; ok {
			continue
		}
		if s.now < batch.Deadline {
			s.fail("t=%s termination batch %d disappeared before deadline %s",
				s.now, id, batch.Deadline)
		}
	}
}

func (s *terminationSim) applyAction(action Action) {
	s.t.Helper()
	switch action.Kind {
	case ActionNone:
		return
	case ActionScaleUp:
		for i := 0; i < action.Replicas; i++ {
			s.pods = append(s.pods, simPod{
				phase:   podStarting,
				readyAt: s.now + s.cfg.policy.ReadinessDelay,
			})
		}
	case ActionScaleDown:
		unreadyLeft := action.TerminateUnready
		for i := range s.pods {
			if unreadyLeft == 0 {
				break
			}
			if s.pods[i].phase == podStarting || s.pods[i].phase == podUnready {
				s.pods[i].phase = podTerminating
				s.pods[i].deadline = action.CompleteBy
				unreadyLeft--
			}
		}
		readyLeft := action.TerminateReady
		for i := range s.pods {
			if readyLeft == 0 {
				break
			}
			if s.pods[i].phase == podReady {
				s.pods[i].phase = podTerminating
				s.pods[i].deadline = action.CompleteBy
				readyLeft--
			}
		}
		if unreadyLeft != 0 || readyLeft != 0 {
			s.fail("t=%s could not apply termination split: unready left %d, ready left %d",
				s.now, unreadyLeft, readyLeft)
		}
	}
}

func (s *terminationSim) fail(format string, args ...any) {
	s.t.Helper()
	s.violations = append(s.violations, fmt.Sprintf(format, args...))
}

func TestSimulationCapacityDropAndRestore(t *testing.T) {
	t.Parallel()

	sim := newTerminationSim(t, simConfig{
		policy:              testPolicy(10, 2, 2, 2*time.Second, 3*time.Second),
		initialReady:        10,
		capacity:            12,
		step:                time.Second,
		duration:            20 * time.Second,
		capacityChanges:     map[time.Duration]int{2 * time.Second: 8, 12 * time.Second: 12},
		checkObservedBounds: true,
		expectConverged:     true,
	})
	sim.run()

	if got := sim.decisionsAt(2 * time.Second); got.Action.Kind != ActionScaleDown || got.Action.Replicas != 2 {
		t.Fatalf("capacity drop action = %+v, want scale-down 2", got.Action)
	}
	if got := sim.decisionsAt(12 * time.Second); got.Action.Kind != ActionScaleUp || got.Action.Replicas != 2 {
		t.Fatalf("capacity restore action = %+v, want scale-up 2", got.Action)
	}
}

func TestSimulationCapacityBelowAvailabilityFloor(t *testing.T) {
	t.Parallel()

	sim := newTerminationSim(t, simConfig{
		policy:              testPolicy(10, 2, 2, 1*time.Second, 3*time.Second),
		initialReady:        10,
		capacity:            12,
		step:                time.Second,
		duration:            20 * time.Second,
		capacityChanges:     map[time.Duration]int{2 * time.Second: 3, 10 * time.Second: 12},
		checkObservedBounds: true,
		expectConverged:     true,
	})
	sim.run()

	var sawInfeasible bool
	for _, decision := range sim.decisions {
		if decision.At >= 2*time.Second && decision.At < 10*time.Second && !decision.Feasible {
			sawInfeasible = true
		}
	}
	if !sawInfeasible {
		t.Fatal("planner never reported the capacity-limited availability floor as infeasible")
	}
}

func TestSimulationTerminationSurvivesCapacityRecompute(t *testing.T) {
	t.Parallel()

	sim := newTerminationSim(t, simConfig{
		policy:              testPolicy(10, 2, 2, 1*time.Second, 5*time.Second),
		initialReady:        12,
		capacity:            12,
		step:                time.Second,
		duration:            20 * time.Second,
		capacityChanges:     map[time.Duration]int{2 * time.Second: 9, 8 * time.Second: 12},
		checkObservedBounds: true,
		expectConverged:     true,
	})
	sim.run()

	if len(sim.batches) < 2 {
		t.Fatalf("expected at least two termination batches, got %+v", sim.batches)
	}
	ids := make([]uint64, 0, len(sim.batches))
	for id := range sim.batches {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if sim.batches[ids[0]].Deadline != 5*time.Second {
		t.Fatalf("first batch deadline changed: %+v", sim.batches[ids[0]])
	}
	if sim.batches[ids[1]].Deadline != 7*time.Second {
		t.Fatalf("second batch deadline = %s, want 7s", sim.batches[ids[1]].Deadline)
	}
}

func TestSimulationReadinessOscillationWithinBudget(t *testing.T) {
	t.Parallel()

	sim := newTerminationSim(t, simConfig{
		policy:       testPolicy(10, 2, 2, 1*time.Second, 3*time.Second),
		initialReady: 12,
		capacity:     12,
		step:         time.Second,
		duration:     20 * time.Second,
		flaps: map[time.Duration]int{
			1 * time.Second: 2,
			5 * time.Second: 2,
			9 * time.Second: 2,
		},
		checkObservedBounds: true,
		expectConverged:     true,
	})
	sim.run()

	if len(sim.batches) != 1 {
		t.Fatalf("expected one termination batch, got %+v", sim.batches)
	}
	if sim.batches[1].Deadline != 3*time.Second {
		t.Fatalf("termination was altered by readiness churn or capacity recompute: %+v", sim.batches[1])
	}
}

func TestSimulationReadinessOutageRecovers(t *testing.T) {
	t.Parallel()

	sim := newTerminationSim(t, simConfig{
		policy:       testPolicy(10, 2, 2, 1*time.Second, 3*time.Second),
		initialReady: 10,
		capacity:     12,
		step:         time.Second,
		duration:     30 * time.Second,
		flaps: map[time.Duration]int{
			1 * time.Second: 4,
			5 * time.Second: 4,
			9 * time.Second: 4,
		},
		checkObservedBounds: false,
		expectConverged:     true,
	})
	sim.run()

	sawAvailabilityRecovery := false
	for _, decision := range sim.decisions {
		if decision.Action.Kind == ActionScaleUp && decision.Observation.Available < decision.Bounds.MinAvailable {
			sawAvailabilityRecovery = true
		}
		if decision.Action.Kind == ActionScaleDown &&
			decision.Observation.Available < decision.Bounds.MinAvailable &&
			decision.Action.TerminateReady > 0 {
			t.Fatalf("t=%s terminated ready pods during an availability outage: %+v", decision.At, decision.Action)
		}
	}
	if !sawAvailabilityRecovery {
		t.Fatal("planner never used surge capacity to recover availability")
	}
}

func TestSimulationCapacityPolicyMatrix(t *testing.T) {
	t.Parallel()

	for desired := 1; desired <= 12; desired++ {
		for surge := 0; surge <= 3; surge++ {
			for unavailable := 0; unavailable <= 3; unavailable++ {
				if surge == 0 && unavailable == 0 {
					continue
				}
				desired, surge, unavailable := desired, surge, unavailable
				name := fmt.Sprintf("desired=%d/surge=%d/unavailable=%d", desired, surge, unavailable)
				t.Run(name, func(t *testing.T) {
					minAvailable := desired - unavailable
					if minAvailable < 0 {
						minAvailable = 0
					}
					drop := minAvailable
					if drop > desired-1 {
						drop = desired - 1
					}
					if drop < 0 {
						drop = 0
					}

					sim := newTerminationSim(t, simConfig{
						policy:       testPolicy(desired, surge, unavailable, time.Second, 3*time.Second),
						initialReady: desired,
						capacity:     desired + surge,
						step:         time.Second,
						duration:     20 * time.Second,
						capacityChanges: map[time.Duration]int{
							2 * time.Second:  drop,
							10 * time.Second: desired + surge,
						},
						checkObservedBounds: true,
						expectConverged:     true,
					})
					sim.run()
					for _, batch := range sim.batches {
						if batch.Deadline <= batch.StartedAt {
							t.Fatalf("invalid termination batch: %+v", batch)
						}
					}
				})
			}
		}
	}
}

func (s *terminationSim) decisionsAt(at time.Duration) Decision {
	s.t.Helper()
	for _, decision := range s.decisions {
		if decision.At == at {
			return decision
		}
	}
	s.t.Fatalf("no decision at %s", at)
	return Decision{}
}
