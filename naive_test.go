package formal

import "time"

// nstate is a hand-written "naive lease table": one flat record per object and
// plain conditional transitions with no production state machine reuse. The
// interleaving tests replay every micro-step through both the Manager steps
// and these naive steps and require identical outcomes at every boundary.
type nstate struct {
	exists bool
	lease  Lease
	dirty  bool
	data   []byte
}

// nstep mirrors one production step. The boolean reports termination.
type nstep func(n *nstate, ctx *stealCtx) (Lease, error, bool)

// stealCtx is the naive table's per-operation scratch space, mirroring the
// production opState fields used by the steal transition.
type stealCtx struct {
	victim    Lease
	hasVictim bool
}

func (m *Manager) naiveAcquire(object, holder string, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.exists && n.lease.Holder != holder && n.lease.Deadline.After(m.now()) {
				return Lease{}, ErrHeldByOther, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			epoch := uint64(1)
			if n.exists {
				epoch = n.lease.Epoch + 1
			}
			l := Lease{Object: object, Holder: holder, Epoch: epoch, Deadline: m.now().Add(m.ttl)}
			n.exists, n.lease, n.dirty, n.data = true, l, false, nil
			return l, nil, true
		},
	}
}

func (m *Manager) naiveRenew(token Lease, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.exists {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.lease.Epoch != token.Epoch || n.lease.Holder != token.Holder {
				return Lease{}, ErrStaleToken, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.lease.Deadline.After(m.now()) {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			n.lease.Deadline = m.now().Add(m.ttl)
			return n.lease, nil, true
		},
	}
}

func (m *Manager) naiveMarkDirty(token Lease, data []byte, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.exists {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.lease.Epoch != token.Epoch || n.lease.Holder != token.Holder {
				return Lease{}, ErrStaleToken, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			buf := make([]byte, len(data))
			copy(buf, data)
			n.dirty, n.data = true, buf
			return Lease{}, nil, true
		},
	}
}

func (m *Manager) naiveFlush(token Lease, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.exists {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.lease.Epoch != token.Epoch || n.lease.Holder != token.Holder {
				return Lease{}, ErrStaleToken, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.lease.Deadline.After(m.now()) {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.dirty {
				return Lease{}, ErrNotDirty, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if err := m.sink.WriteBack(token.Object, token.Epoch, n.data); err != nil {
				return Lease{}, err, true
			}
			n.dirty, n.data = false, nil
			return n.lease, nil, true
		},
	}
}

func (m *Manager) naiveBreak(token Lease, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !n.exists {
				return Lease{}, ErrNotHeld, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.lease.Epoch != token.Epoch || n.lease.Holder != token.Holder {
				return Lease{}, ErrStaleToken, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.dirty {
				if err := m.sink.WriteBack(token.Object, token.Epoch, n.data); err != nil {
					return Lease{}, err, true
				}
				n.dirty, n.data = false, nil
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			n.exists, n.lease, n.dirty, n.data = false, Lease{}, false, nil
			return Lease{}, nil, true
		},
	}
}

func (m *Manager) naiveSteal(object, thief string, ctx *stealCtx) []nstep {
	return []nstep{
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.exists && n.lease.Holder == thief {
				return Lease{}, ErrHeldByOther, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if n.exists {
				ctx.victim, ctx.hasVictim = n.lease, true
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !ctx.hasVictim {
				return Lease{}, nil, false
			}
			if !n.exists || n.lease.Epoch != ctx.victim.Epoch || n.lease.Holder != ctx.victim.Holder {
				return Lease{}, ErrStaleToken, true
			}
			if n.dirty {
				if err := m.sink.WriteBack(object, ctx.victim.Epoch, n.data); err != nil {
					return Lease{}, err, true
				}
				n.dirty, n.data = false, nil
			}
			return Lease{}, nil, false
		},
		func(n *nstate, ctx *stealCtx) (Lease, error, bool) {
			if !ctx.hasVictim {
				if n.exists {
					return Lease{}, ErrStaleToken, true
				}
				l := Lease{Object: object, Holder: thief, Epoch: 1, Deadline: m.now().Add(m.ttl)}
				n.exists, n.lease, n.dirty, n.data = true, l, false, nil
				return l, nil, true
			}
			if !n.exists || n.lease.Epoch != ctx.victim.Epoch || n.lease.Holder != ctx.victim.Holder {
				return Lease{}, ErrStaleToken, true
			}
			l := Lease{Object: object, Holder: thief, Epoch: ctx.victim.Epoch + 1, Deadline: m.now().Add(m.ttl)}
			n.exists, n.lease, n.dirty, n.data = true, l, false, nil
			return l, nil, true
		},
	}
}

func freshClock() (func() time.Time, *time.Time) {
	t := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	return func() time.Time {
		return t
	}, &t
}
