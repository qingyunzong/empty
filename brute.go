package bitemp

import "time"

// BruteForce resolves key at (validAt, asOfSeq) by replaying the entire
// commit log from scratch. It is deliberately implemented on a different
// code path than Store.Query (full replay into per-layer maps instead of
// a single selection pass) so tests can cross-check the two over a
// (valid time x tx time) grid.
func BruteForce(s *Store, key string, validAt time.Time, asOfSeq int64) (Hit, bool) {
	// Replay: fold every visible commit into the latest state per layer.
	type layer struct {
		from time.Time
		rev  Revision
	}
	layers := map[time.Time]*layer{}
	var order []*layer
	for _, rev := range s.revs {
		if rev.Key != key || rev.Seq > asOfSeq {
			continue
		}
		l, ok := layers[rev.ValidFrom]
		if !ok {
			l = &layer{from: rev.ValidFrom}
			layers[rev.ValidFrom] = l
			order = append(order, l)
		}
		l.rev = rev // later commit corrects the layer
	}

	// Resolve: among layers covering validAt, the most recent valid
	// layer decides.
	var win *layer
	for _, l := range order {
		if !l.rev.Covers(validAt) {
			continue
		}
		if win == nil || l.from.After(win.from) {
			win = l
		}
	}
	if win == nil {
		return Hit{}, false
	}
	return Hit{Revision: win.rev, Active: !win.rev.Retracted}, true
}
