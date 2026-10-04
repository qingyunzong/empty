package kvmerge

// Model is an uncompressed read model used as a test oracle: it keeps
// every operation ever applied and answers historical point lookups by
// scanning the full history, with no compaction at all.
type Model struct {
	hist map[string][]Entry // per key, in apply (seq ascending) order
}

func NewModel() *Model {
	return &Model{hist: make(map[string][]Entry)}
}

// Apply records one operation. Callers must apply in seq ascending order.
func (m *Model) Apply(e Entry) {
	m.hist[e.Key] = append(m.hist[e.Key], e)
}

// Get returns the value visible at the given sequence number.
func (m *Model) Get(key string, seq uint64) (string, bool) {
	vs := m.hist[key]
	for i := len(vs) - 1; i >= 0; i-- {
		if vs[i].Seq <= seq {
			if vs[i].Del {
				return "", false
			}
			return vs[i].Val, true
		}
	}
	return "", false
}
