package crashreplay

// Op is the kind of a replayed event.
type Op string

const (
	OpWrite Op = "write"
	OpSync  Op = "sync"
	OpCrash Op = "crash"
)

// Event is a single record in the publish stream. Seq totally orders the
// stream; events may be published out of order and are sorted before replay.
type Event struct {
	Seq   int    `json:"seq"`
	Op    Op     `json:"op"`
	Key   string `json:"key,omitempty"`
	Value string `json:"value,omitempty"`
}
