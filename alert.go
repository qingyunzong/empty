package formal

import "time"

// Alert is one firing alert. Alert identity is defined solely by Labels:
// repeated arrivals with the same labels are the same alert, regardless of
// StartsAt or label map iteration order.
type Alert struct {
	Labels   Labels
	StartsAt time.Time
}

// Fingerprint returns the stable identity of the alert.
func (a Alert) Fingerprint() string {
	return a.Labels.String()
}

// Clone returns an alert with an independent label map.
func (a Alert) Clone() Alert {
	return Alert{Labels: cloneLabels(a.Labels), StartsAt: a.StartsAt}
}

func earlierAlert(a, b Alert) Alert {
	switch {
	case a.StartsAt.IsZero():
		return b.Clone()
	case b.StartsAt.IsZero():
		return a.Clone()
	case b.StartsAt.Before(a.StartsAt):
		return b.Clone()
	default:
		return a.Clone()
	}
}
