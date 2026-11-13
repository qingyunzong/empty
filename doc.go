// Package dataeng provides a NetFlow v9 and IPFIX template registry for flow
// collectors.
//
// Templates are keyed by exporter, observation domain and template ID.
// A Store snapshots active templates when a packet is received, so a template
// refresh only affects later packets. Data sets without an active template are
// kept in a bounded FIFO and returned when a matching template arrives, in
// their original receive order. Options templates live in a separate registry.
// Missing or expired templates are never replaced by a guessed field layout.
package dataeng
