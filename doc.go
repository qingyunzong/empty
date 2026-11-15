// Package dataeng provides an importable incremental IMAP mailbox state
// library for an email archiving service.
//
// The library maintains one snapshot per mailbox, split into generations
// keyed by UIDVALIDITY. A UIDVALIDITY change opens a fresh, empty generation
// and forces a full rescan; UID cursors from an older generation are never
// reused. Within a generation it jointly tracks UID, MODSEQ, EXPUNGE /
// QRESYNC VANISHED events and RFC 5322 body digests.
//
// Removal evidence is preserved as tombstones, including removals of UIDs
// whose bodies were never fetched. Replay orders out-of-order QRESYNC events
// by MODSEQ before applying them, so replaying an event batch converges on
// the same snapshot as reconciling against the complete UID list.
//
// Typical flow:
//
//	state := dataeng.New()
//	sel, _ := state.Select("INBOX", uidValidity)
//	if sel.FullRescan {
//	    report, _ := state.Reconcile("INBOX", fullListing)
//	    _ = report
//	} else {
//	    _, _ = state.Replay("INBOX", qresyncEvents)
//	}
//	_ = state.Save(ctx, dataeng.NewFileStore("state.json"))
package dataeng
