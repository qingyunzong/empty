package formal

type probeTracker struct {
	attempts      int
	successes     int
	failures      int
	successStreak int
	failureStreak int
}

func (t *probeTracker) record(pass bool) {
	t.attempts++
	if pass {
		t.successes++
		t.successStreak++
		t.failureStreak = 0
		return
	}
	t.failures++
	t.failureStreak++
	t.successStreak = 0
}

func (t *probeTracker) status() ProbeStatus {
	return ProbeStatus{
		Attempts:             t.attempts,
		Successes:            t.successes,
		Failures:             t.failures,
		ConsecutiveSuccesses: t.successStreak,
		ConsecutiveFailures:  t.failureStreak,
	}
}

type instance struct {
	id InstanceID

	startup   probeTracker
	readiness probeTracker
	liveness  probeTracker

	startupDone      bool
	startupFailed    bool
	readinessPassing bool
	livenessHealthy  bool
}

func newInstance(id InstanceID) *instance {
	return &instance{
		id:              id,
		livenessHealthy: true,
	}
}

func (in *instance) record(cfg Config, kind ProbeKind, result ProbeResult) {
	pass := result == ProbePass

	switch kind {
	case ProbeStartup:
		in.startup.record(pass)
		if pass {
			if in.startup.successStreak >= cfg.StartupSuccessThreshold {
				in.startupDone = true
				in.startupFailed = false
			}
		} else if !in.startupDone && in.startup.failureStreak >= cfg.StartupFailureThreshold {
			in.startupFailed = true
		}

	case ProbeReadiness:
		in.readiness.record(pass)
		if pass {
			if in.readiness.successStreak >= cfg.ReadinessSuccessThreshold {
				in.readinessPassing = true
			}
		} else if in.readiness.failureStreak >= cfg.ReadinessFailureThreshold {
			in.readinessPassing = false
		}

	case ProbeLiveness:
		in.liveness.record(pass)
		if pass {
			if in.liveness.successStreak >= cfg.LivenessSuccessThreshold {
				in.livenessHealthy = true
			}
		} else if in.liveness.failureStreak >= cfg.LivenessFailureThreshold {
			in.livenessHealthy = false
		}
	}
}

func (in *instance) state() State {
	if in.startupFailed {
		return StateUnhealthy
	}
	if !in.startupDone {
		return StateStarting
	}
	if !in.livenessHealthy {
		return StateUnhealthy
	}
	if !in.readinessPassing {
		return StateNotReady
	}
	return StateReady
}

func (in *instance) backoffStreak() int {
	streak := maxInt(in.readiness.failureStreak, in.liveness.failureStreak)
	if !in.startupDone {
		streak = maxInt(streak, in.startup.failureStreak)
	}
	return streak
}

func (in *instance) snapshot(cfg Config) Snapshot {
	state := in.state()
	backoff := in.backoffStreak()
	return Snapshot{
		ID:               in.id,
		State:            state,
		Ready:            state == StateReady,
		ReceivesTraffic:  state.TrafficEligible(),
		StartupDone:      in.startupDone,
		StartupFailed:    in.startupFailed,
		ReadinessPassing: in.readinessPassing,
		LivenessHealthy:  in.livenessHealthy,
		Startup:          in.startup.status(),
		Readiness:        in.readiness.status(),
		Liveness:         in.liveness.status(),
		BackoffLevel:     backoff,
		NextProbeDelay:   cfg.BackoffDelay(backoff),
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
