// Package sched provides exact appointment scheduling for small instances
// (up to roughly 16 requests). It selects a maximum-profit subset of
// requests and places every stage of each selected request on room and
// equipment resources, honoring disinfection buffers, inter-stage gap
// limits and immovable confirmed bookings. Among maximum-profit solutions
// it prefers the one that changes the previous plan the least.
package sched

// Window is a candidate half-open time interval [Start, End) for one stage.
type Window struct {
	Start, End int
}

// Stage describes one examination stage of a request.
type Stage struct {
	RoomType  string   // required room type
	Equipment string   // required equipment instance ID
	Before    int      // disinfection time reserved before the stage
	After     int      // disinfection time reserved after the stage
	Windows   []Window // candidate windows
	MinGap    int      // min delay from previous stage end to this stage start
	MaxGap    int      // max delay; negative means unbounded
}

// PlanEntry records where each stage of a request is placed.
type PlanEntry struct {
	Windows []int    // chosen candidate window index per stage
	Rooms   []string // chosen room instance ID per stage
}

// Request is a bookable order with one or two stages. A request is either
// fully scheduled (all stages placed) or fully cancelled: cancelling one
// stage cancels the whole order.
type Request struct {
	ID     string
	Profit int
	Stages []Stage
	Locked *PlanEntry // confirmed booking: must keep exactly this placement
}

// Room is a room instance of a given type.
type Room struct {
	ID   string
	Type string
}

// Problem is a full scheduling instance.
type Problem struct {
	Rooms     []Room
	Equipment []string
	Requests  []Request
	OldPlan   map[string]*PlanEntry // previous plan, used for tie-breaking
}

// Interval is a half-open time interval [Start, End).
type Interval struct {
	Start, End int
}

// OccupiedInterval is one stage's footprint on a resource.
type OccupiedInterval struct {
	RequestID string
	Stage     int
	Core      Interval // procedure time
	Busy      Interval // Core extended by the disinfection buffers
}

// ResourceTimeline certifies that one resource is never double-booked.
type ResourceTimeline struct {
	ResourceID string
	Kind       string // "room" or "equipment"
	Entries    []OccupiedInterval
}

// StageGapCertificate certifies the gap between the two stages of a
// scheduled two-stage request.
type StageGapCertificate struct {
	RequestID           string
	FirstEnd            int
	SecondStart         int
	Gap, MinGap, MaxGap int
}

// Solution is the solver output: the chosen placements plus certificates.
type Solution struct {
	Profit      int
	Changes     int // number of requests whose placement differs from OldPlan
	Assignments map[string]PlanEntry
	Timelines   []ResourceTimeline
	StageGaps   []StageGapCertificate
}
