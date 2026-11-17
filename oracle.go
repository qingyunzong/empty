package formal

import "sort"

type accepted struct {
	event  Event
	window Window
}

type windowKey struct{ start, end int64 }

// NaiveOracle recomputes the expected final window output from the full input
// history using a deliberately simple, streaming-free algorithm. It mirrors
// the operator's event-time contract:
//
//   - watermarks only advance;
//   - an event is accepted iff its timestamp plus allowed lateness is not
//     earlier than the watermark in effect when it arrives;
//   - tumbling events are grouped by their fixed window;
//   - session events are re-grouped from scratch by repeatedly merging
//     overlapping session intervals.
//
// The returned rows are sorted by (Window.Start, Window.End).
func NaiveOracle(signals []Signal, assigner Assigner, allowedLateness int64) []Row {
	latency := allowedLateness
	if latency < 0 {
		latency = 0
	}
	watermark := MinTimestamp
	var events []accepted

	for _, signal := range signals {
		if signal.IsWatermark {
			if signal.Watermark > watermark {
				watermark = signal.Watermark
			}
			continue
		}
		event := signal.Event
		windows := assigner.Assign(event)
		if len(windows) == 0 {
			continue
		}
		window := windows[0]
		if watermark != MinTimestamp && event.Timestamp+latency < watermark {
			continue
		}
		events = append(events, accepted{event: event, window: window})
	}

	if assigner.kind() == kindSession {
		return naiveSessions(events)
	}
	return naiveTumbling(events)
}

func naiveTumbling(events []accepted) []Row {
	aggregates := make(map[windowKey]*Row)
	for _, item := range events {
		k := windowKey{item.window.Start, item.window.End}
		row, ok := aggregates[k]
		if !ok {
			row = &Row{Window: item.window}
			aggregates[k] = row
		}
		row.Count++
		row.Sum += item.event.Value
	}
	return sortedRows(aggregates)
}

func naiveSessions(events []accepted) []Row {
	// Every accepted event starts as [ts, ts+gap); merge overlapping intervals
	// until a fixed point, then aggregate.
	type interval struct {
		start, end int64
	}
	intervals := make([]interval, 0, len(events))
	for _, item := range events {
		intervals = append(intervals, interval{item.window.Start, item.window.End})
	}
	sort.Slice(intervals, func(i, j int) bool {
		if intervals[i].start != intervals[j].start {
			return intervals[i].start < intervals[j].start
		}
		return intervals[i].end < intervals[j].end
	})

	type component struct{ start, end int64 }
	var components []component
	for _, in := range intervals {
		if len(components) == 0 || components[len(components)-1].end < in.start {
			components = append(components, component{in.start, in.end})
			continue
		}
		last := &components[len(components)-1]
		if in.end > last.end {
			last.end = in.end
		}
	}

	aggregates := make(map[windowKey]*Row)
	for _, item := range events {
		index := sort.Search(len(components), func(i int) bool {
			return components[i].end >= item.window.Start
		})
		comp := components[index]
		k := windowKey{comp.start, comp.end}
		row, ok := aggregates[k]
		if !ok {
			row = &Row{Window: Window{Start: comp.start, End: comp.end}}
			aggregates[k] = row
		}
		row.Count++
		row.Sum += item.event.Value
	}
	return sortedRows(aggregates)
}

func sortedRows(aggregates map[windowKey]*Row) []Row {
	rows := make([]Row, 0, len(aggregates))
	for _, row := range aggregates {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Window.Start != rows[j].Window.Start {
			return rows[i].Window.Start < rows[j].Window.Start
		}
		return rows[i].Window.End < rows[j].Window.End
	})
	return rows
}
