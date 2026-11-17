package formal

import "time"

type windowCounts struct {
	total    uint64
	failures uint64
	slows    uint64
}

type sampleWindow struct {
	bucketWidth time.Duration
	bucketCount int64
	buckets     map[int64]windowCounts
}

func newSampleWindow(window time.Duration, buckets int) sampleWindow {
	width := window / time.Duration(buckets)
	if width <= 0 {
		width = time.Nanosecond
	}
	return sampleWindow{
		bucketWidth: width,
		bucketCount: int64(buckets),
		buckets:     make(map[int64]windowCounts),
	}
}

func (w *sampleWindow) reset() {
	clear(w.buckets)
}

func (w *sampleWindow) index(now time.Time) int64 {
	return now.UnixNano() / int64(w.bucketWidth)
}

func (w *sampleWindow) prune(now time.Time) {
	oldest := w.index(now) - w.bucketCount + 1
	for index := range w.buckets {
		if index < oldest {
			delete(w.buckets, index)
		}
	}
}

func (w *sampleWindow) record(now time.Time, failed, slow bool) {
	w.prune(now)
	index := w.index(now)
	counts := w.buckets[index]
	counts.total++
	if failed {
		counts.failures++
	}
	if slow {
		counts.slows++
	}
	w.buckets[index] = counts
}

func (w *sampleWindow) snapshot(now time.Time) windowCounts {
	w.prune(now)
	var result windowCounts
	for _, counts := range w.buckets {
		result.total += counts.total
		result.failures += counts.failures
		result.slows += counts.slows
	}
	return result
}
