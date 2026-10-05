package main

// DefaultSpec is the built-in planning instance: 18 candidate assertions and
// 12 fault models. M12 is deliberately indistinguishable (no assertion
// separates it from normal) to exercise the separate listing. Side-effect
// groups write-io, net-inject and svc-restart are mutually exclusive.
func DefaultSpec() Spec {
	return Spec{
		Models: []FaultModel{
			{ID: "M01", Name: "disk-latency-spike"},
			{ID: "M02", Name: "disk-corruption"},
			{ID: "M03", Name: "network-partition"},
			{ID: "M04", Name: "packet-loss"},
			{ID: "M05", Name: "cpu-throttle"},
			{ID: "M06", Name: "memory-leak"},
			{ID: "M07", Name: "clock-skew"},
			{ID: "M08", Name: "config-drift"},
			{ID: "M09", Name: "auth-token-expiry"},
			{ID: "M10", Name: "queue-backlog"},
			{ID: "M11", Name: "cache-stampede"},
			{ID: "M12", Name: "firmware-mismatch"},
		},
		Assertions: []Assertion{
			{ID: "A01", Name: "fsync-latency-probe", Cost: 4, SideEffectGroup: "write-io",
				Preconditions: []string{"fs-access"}, Distinguishes: []string{"M01", "M02"}},
			{ID: "A02", Name: "read-checksum-verify", Cost: 2,
				Preconditions: []string{"fs-access"}, Distinguishes: []string{"M02"}},
			{ID: "A03", Name: "partition-inject", Cost: 6, SideEffectGroup: "net-inject",
				Preconditions: []string{"net-admin", "quorum-ok"}, Distinguishes: []string{"M03", "M04"}},
			{ID: "A04", Name: "ping-mesh", Cost: 3,
				Preconditions: []string{"net-admin"}, Distinguishes: []string{"M03"}},
			{ID: "A05", Name: "loss-sim", Cost: 5, SideEffectGroup: "net-inject",
				Preconditions: []string{"net-admin"}, Distinguishes: []string{"M04"}},
			{ID: "A06", Name: "cpu-profile", Cost: 2,
				Distinguishes: []string{"M05"}},
			{ID: "A07", Name: "heap-diff", Cost: 3,
				Preconditions: []string{"trace-enabled"}, Distinguishes: []string{"M06"}},
			{ID: "A08", Name: "gc-pressure", Cost: 4, SideEffectGroup: "svc-restart",
				Preconditions: []string{"trace-enabled"}, Distinguishes: []string{"M05", "M06"}},
			{ID: "A09", Name: "ntp-offset", Cost: 1,
				Preconditions: []string{"net-admin"}, Distinguishes: []string{"M07"}},
			{ID: "A10", Name: "config-hash", Cost: 1,
				Distinguishes: []string{"M08"}},
			{ID: "A11", Name: "token-refresh", Cost: 2,
				Preconditions: []string{"auth-admin"}, Distinguishes: []string{"M09"}},
			{ID: "A12", Name: "queue-depth", Cost: 2,
				Preconditions: []string{"mq-access"}, Distinguishes: []string{"M10"}},
			{ID: "A13", Name: "cache-hit-ratio", Cost: 2,
				Preconditions: []string{"metrics-access"}, Distinguishes: []string{"M11"}},
			{ID: "A14", Name: "restart-probe", Cost: 7, SideEffectGroup: "svc-restart",
				Preconditions: []string{"quorum-ok"}, Distinguishes: []string{"M05", "M10"}},
			{ID: "A15", Name: "disk-smart", Cost: 3, SideEffectGroup: "write-io",
				Preconditions: []string{"fs-access"}, Distinguishes: []string{"M01"}},
			{ID: "A16", Name: "tls-handshake", Cost: 2,
				Preconditions: []string{"net-admin", "auth-admin"}, Distinguishes: []string{"M09"}},
			{ID: "A17", Name: "lag-reporter", Cost: 3,
				Preconditions: []string{"mq-access", "metrics-access"}, Distinguishes: []string{"M10", "M11"}},
			{ID: "A18", Name: "broad-sweep", Cost: 30,
				Preconditions: []string{"maintenance-window"},
				Distinguishes: []string{"M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"}},
		},
	}
}
