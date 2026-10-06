package calib

// Snapshot 是某一历史版本的不可变快照，增删约束后旧快照保持有效。
type Snapshot struct {
	version     int
	constraints map[int]Constraint
	pot         map[int]Transform
	comp        map[int]int
}

// Version 返回快照对应的版本号。
func (s *Snapshot) Version() int { return s.version }

// Transform 返回该版本下机器人 v 相对其连通组原点的势变换。
func (s *Snapshot) Transform(v int) (Transform, bool) {
	t, ok := s.pot[v]
	return t, ok
}

// Component 返回该版本下机器人 v 所在连通组的原点（组内最小 ID）。
func (s *Snapshot) Component(v int) (int, bool) {
	root, ok := s.comp[v]
	return root, ok
}

// Relative 返回该版本下 value[to] ∘ value[from]^{-1}，两点须同组。
func (s *Snapshot) Relative(from, to int) (Transform, bool) {
	pf, okF := s.pot[from]
	pt, okT := s.pot[to]
	if !okF || !okT || s.comp[from] != s.comp[to] {
		return Transform{}, false
	}
	return pt.Compose(pf.Inverse()), true
}

// Constraints 返回该版本下的全部约束副本。
func (s *Snapshot) Constraints() map[int]Constraint {
	return copyConstraints(s.constraints)
}
