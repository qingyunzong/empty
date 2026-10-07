package cutting

// StockType is a purchasable bar: unlimited supply at the given cost.
type StockType struct {
	Length int `json:"length"`
	Cost   int `json:"cost"`
}

// Bar is a physical bar available from inventory (a remnant of a previous
// order). It carries a stable ID and a source chain describing its origin.
type Bar struct {
	ID     string `json:"id"`
	Length int    `json:"length"`
	Source string `json:"source,omitempty"`
}

// Demand is a required count of pieces of one integer length.
type Demand struct {
	Length int `json:"length"`
	Count  int `json:"count"`
}

// Spec describes one cutting order.
type Spec struct {
	OrderID         string      `json:"orderId,omitempty"`
	Kerf            int         `json:"kerf"`       // material lost per cut
	MinRemnant      int         `json:"minRemnant"` // leftover below this is scrapped
	CutCost         int         `json:"cutCost"`    // money charged per cut
	StockTypes      []StockType `json:"stockTypes"`
	Remnants        []Bar       `json:"remnants,omitempty"`
	Demands         []Demand    `json:"demands"`
	MaxPiecesPerBar int         `json:"maxPiecesPerBar,omitempty"` // default 16
	MaxBars         int         `json:"maxBars,omitempty"`         // default 8
	RemnantPrefix   string      `json:"remnantPrefix,omitempty"`   // default "R"
	NextRemnantNum  int         `json:"nextRemnantNum,omitempty"`  // first free remnant number
}
