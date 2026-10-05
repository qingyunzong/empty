package cut

// Job describes one cutting order.
type Job struct {
	Kerf           int         `json:"kerf"`           // saw loss per cut
	ScrapThreshold int         `json:"scrapThreshold"` // leftover below this is scrapped
	CutCost        int         `json:"cutCost"`        // money charged per cut
	MaxBars        int         `json:"maxBars"`        // 0 means default 8, hard limit 8
	OrderID        string      `json:"orderId"`
	StockTypes     []StockType `json:"stockTypes"`
	Demands        []Demand    `json:"demands"`
	Inventory      []Bar       `json:"inventory,omitempty"` // reusable leftovers from earlier orders
	History        []Bar       `json:"-"`                   // all known bars, for lineage lookup
}

type StockType struct {
	Length int `json:"length"`
	Cost   int `json:"cost"`
	Max    int `json:"max"` // 0 = unlimited (still capped by MaxBars)
}

type Demand struct {
	Label  string `json:"label"`
	Length int    `json:"length"`
	Qty    int    `json:"qty"`
}

// Bar is a physical bar: purchased stock or a reusable leftover.
type Bar struct {
	ID       string `json:"id"`
	Length   int    `json:"length"`
	ParentID string `json:"parentId,omitempty"`
	Origin   string `json:"origin"` // "purchased" | "leftover"
	Order    string `json:"order,omitempty"`
}

type PiecePlacement struct {
	Label  string `json:"label"`
	Length int    `json:"length"`
	BarID  string `json:"barId"`
	Source string `json:"source"` // lineage chain, e.g. "O2-P1-L <- O2-P1"
}

type BarPlan struct {
	BarID         string   `json:"barId"`
	Length        int      `json:"length"`
	Origin        string   `json:"origin"`
	Cost          int      `json:"cost"`
	Cuts          []string `json:"cuts"` // piece labels in cutting order
	CutCount      int      `json:"cutCount"`
	KerfLoss      int      `json:"kerfLoss"`
	Leftover      int      `json:"leftover"`
	LeftoverState string   `json:"leftoverState"` // "none" | "scrap" | "reusable"
	LeftoverID    string   `json:"leftoverId,omitempty"`
}

type Totals struct {
	PurchaseCost   int  `json:"purchaseCost"`
	CutCount       int  `json:"cutCount"`
	CutCost        int  `json:"cutCost"`
	TotalCost      int  `json:"totalCost"`
	PiecesLength   int  `json:"piecesLength"`
	KerfLoss       int  `json:"kerfLoss"`
	Scrap          int  `json:"scrap"`
	Reusable       int  `json:"reusable"`
	StockLength    int  `json:"stockLength"`
	ConservationOK bool `json:"conservationOk"`
}

type Bounds struct {
	Lower int `json:"lower"`
	Upper int `json:"upper"`
}

type Plan struct {
	OrderID      string           `json:"orderId"`
	Feasible     bool             `json:"feasible"`
	Bars         []BarPlan        `json:"bars"`
	Pieces       []PiecePlacement `json:"pieces"`
	Totals       Totals           `json:"totals"`
	Bounds       Bounds           `json:"bounds"`
	NewInventory []Bar            `json:"newInventory,omitempty"`
}
