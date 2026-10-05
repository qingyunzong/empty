package graphtransform

// Certificate records everything needed to independently reproduce and
// check a transformation run: the random seed that generated the chain and
// the chain itself.
type Certificate struct {
	Seed  int64
	Chain Chain
}
