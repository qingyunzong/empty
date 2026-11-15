package dataeng

import "context"

// Fetcher retrieves one listing from the resource API. It must set
// Listing.Complete to false for an error page, a rate-limit response, a
// truncated page, or any other response that is not the complete current
// list. Returning an error is also treated as an incomplete observation.
type Fetcher func(ctx context.Context) (Listing, error)

// Poll performs exactly one API fetch and feeds the result to the detector.
// Calling Poll once per collector cycle makes the API-call budget explicit:
// one call produces at most one complete generation.
//
// A fetch error is recorded as an incomplete observation and returned to the
// caller. A listing with Complete set to false is accepted without an error;
// it is recorded as an incomplete observation and produces no events.
func (d *Detector) Poll(ctx context.Context, fetch Fetcher) ([]Event, error) {
	listing, err := fetch(ctx)
	if err != nil {
		d.ObserveIncomplete()
		return nil, err
	}
	return d.Observe(listing), nil
}
