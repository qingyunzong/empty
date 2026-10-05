package rollup

import "fmt"

// ErrInjectedFault is returned by Apply when the FaultInjector fires.
var ErrInjectedFault = fmt.Errorf("rollup: injected fault")

// Layer identifies one of the three materialized count layers updated
// by Apply.
type Layer int

const (
	LayerDay Layer = iota
	LayerWeek
	LayerMonth
)

// FaultInjector simulates crashes during the three-layer update in
// Apply. When armed at layer k, the next Apply records the event in
// the durable ledger, applies layers below k, then fails before layer
// k, leaving the counts partially updated (as a real crash would).
// Recover recomputes the counts from the ledger to restore
// consistency.
type FaultInjector struct {
	armed    bool
	layer    Layer
	injected int
}

// Arm arranges for the next Apply to fail before updating the given
// layer. Only one fault can be armed at a time.
func (f *FaultInjector) Arm(layer Layer) {
	f.armed = true
	f.layer = layer
}

// Disarm cancels any armed fault.
func (f *FaultInjector) Disarm() {
	f.armed = false
}

// Injected reports how many faults have fired.
func (f *FaultInjector) Injected() int {
	return f.injected
}

// check is called before updating each layer. It returns
// ErrInjectedFault when an armed fault fires at this layer.
func (f *FaultInjector) check(layer Layer) error {
	if f.armed && f.layer == layer {
		f.armed = false
		f.injected++
		return fmt.Errorf("%w at layer %d", ErrInjectedFault, layer)
	}
	return nil
}
