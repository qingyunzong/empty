// Package formal implements a small, deterministic BGP best-path selection
// library for decision-path callers.
//
// Best-path selection follows this fixed, publicly documented decision order:
//
//  1. Higher LOCAL_PREF wins; an absent attribute defaults to 100.
//  2. A locally originated route beats any peer-learned route.
//  3. Shorter AS_PATH wins; AS_SET segments count as one, empty segments zero.
//  4. ORIGIN wins in IGP < EGP < INCOMPLETE order; unset means IGP.
//  5. Lower MULTI_EXIT_DISC wins; an absent attribute defaults to 0.
//  6. The stable neighbor transport address breaks full attribute ties, with
//     IPv4 ordered before IPv6 and the unspecified address (local routes)
//     first.
//  7. A deterministic stable key guarantees a total order for standalone use.
//
// Route reflection follows RFC 4456 loop-prevention and propagation rules:
// ORIGINATOR_ID/CLUSTER_LIST loops are rejected, reflection sets or preserves
// ORIGINATOR_ID and prepends the local cluster, and Reflectable encodes the
// client/non-client/EBGP advertisement matrix.
//
// RIB selection is a pure function of the surviving (prefix, peer) routes:
// updates replace by peer, withdrawals are idempotent, and every result is
// recomputed from scratch. Interleaved update/withdraw streams therefore
// converge to the same selection regardless of event order.
package formal
