package dataeng

import "sort"

type sourceState struct {
	watermark    int64
	hasWatermark bool
	idle         bool
}

type partitionState struct {
	id           string
	sources      map[string]*sourceState
	watermark    int64
	hasWatermark bool
}

type fixedWindowKey struct {
	Partition string
	Key       string
	Start     int64
	End       int64
}

type fixedWindowState struct {
	partition string
	key       string
	window    Window
	events    []Event
	version   int
	fired     bool
}

type sessionKey struct {
	Partition string
	Key       string
}

type sessionWindowState struct {
	window  Window
	events  []Event
	version int
	fired   bool
}

func (s *sessionWindowState) matches(ts, gap int64) bool {
	// The end already includes the inactivity gap, so both tests are needed:
	// one covers an event inside the session, the other an event that arrives
	// earlier but is still within one gap of the first record. The end
	// boundary is inclusive for merging: an event exactly one gap after the
	// last record still belongs to the same session.
	return ts <= s.window.End && ts+gap >= s.window.Start
}

func sortFixedKeys(keys []fixedWindowKey) {
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.End != b.End {
			return a.End < b.End
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.Partition != b.Partition {
			return a.Partition < b.Partition
		}
		return a.Key < b.Key
	})
}

func sortResults(results []WindowResult) {
	sort.Slice(results, func(i, j int) bool {
		a, b := results[i], results[j]
		if a.Window.End != b.Window.End {
			return a.Window.End < b.Window.End
		}
		if a.Window.Start != b.Window.Start {
			return a.Window.Start < b.Window.Start
		}
		if a.Partition != b.Partition {
			return a.Partition < b.Partition
		}
		if a.Key != b.Key {
			return a.Key < b.Key
		}
		return a.Version < b.Version
	})
}
