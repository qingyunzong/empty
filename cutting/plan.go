package cutting

import (
	"fmt"
	"strings"
)

// PlacedPiece is one demanded piece assigned to a bar.
type PlacedPiece struct {
	ID     string `json:"id"`
	Length int    `json:"length"`
}

// BarPlan is the cutting plan of one physical bar, in cutting order.
type BarPlan struct {
	BarID        string        `json:"barId"` // "NEW-n" for purchased, stable ID for reused remnant
	StockLength  int           `json:"stockLength"`
	Source       string        `json:"source"` // purchase info or remnant origin chain
	Purchased    bool          `json:"purchased"`
	PurchaseCost int           `json:"purchaseCost"`
	Pieces       []PlacedPiece `json:"pieces"` // cutting order
	Cuts         int           `json:"cuts"`
	KerfLoss     int           `json:"kerfLoss"`
	Remnant      int           `json:"remnant"`             // kept leftover (>= MinRemnant)
	RemnantID    string        `json:"remnantId,omitempty"` // stable ID of the kept remnant
	Scrap        int           `json:"scrap"`               // leftover below MinRemnant
}

// Bounds gives lower/upper bounds for the order budget.
type Bounds struct {
	PurchaseLower int `json:"purchaseLower"`
	PurchaseUpper int `json:"purchaseUpper"`
	CutsLower     int `json:"cutsLower"`
	CutsUpper     int `json:"cutsUpper"`
	BudgetLower   int `json:"budgetLower"`
	BudgetUpper   int `json:"budgetUpper"`
}

// Plan is a full cutting plan for one order.
type Plan struct {
	OrderID          string    `json:"orderId,omitempty"`
	Bars             []BarPlan `json:"bars"`
	TotalPieces      int       `json:"totalPieces"`
	DemandLength     int       `json:"demandLength"`
	TotalStockLength int       `json:"totalStockLength"`
	TotalKerfLoss    int       `json:"totalKerfLoss"`
	TotalRemnant     int       `json:"totalRemnant"`
	TotalScrap       int       `json:"totalScrap"`
	TotalCuts        int       `json:"totalCuts"`
	PurchaseCost     int       `json:"purchaseCost"`
	CutCostTotal     int       `json:"cutCostTotal"`
	Budget           int       `json:"budget"` // purchase + cut cost
	Bounds           Bounds    `json:"bounds"`
	ConservationOK   bool      `json:"conservationOK"`
	NewRemnants      []Bar     `json:"newRemnants,omitempty"`
	UsedRemnantIDs   []string  `json:"usedRemnantIds,omitempty"`
}

// CheckConservation verifies full length conservation per bar and in total:
// stockLength == sum(pieces) + kerfLoss + remnant + scrap.
func (p *Plan) CheckConservation() bool {
	sumPieces, sumStock, sumKerf, sumRem, sumScrap := 0, 0, 0, 0, 0
	for _, b := range p.Bars {
		ps := 0
		for _, pc := range b.Pieces {
			ps += pc.Length
		}
		if b.StockLength != ps+b.KerfLoss+b.Remnant+b.Scrap {
			return false
		}
		sumPieces += ps
		sumStock += b.StockLength
		sumKerf += b.KerfLoss
		sumRem += b.Remnant
		sumScrap += b.Scrap
	}
	if sumPieces != p.DemandLength || sumStock != p.TotalStockLength ||
		sumKerf != p.TotalKerfLoss || sumRem != p.TotalRemnant || sumScrap != p.TotalScrap {
		return false
	}
	return p.TotalStockLength == p.DemandLength+p.TotalKerfLoss+p.TotalRemnant+p.TotalScrap
}

// Report renders the plan: per-bar cutting order, per-piece source tree,
// length conservation and budget bounds.
func (p *Plan) Report() string {
	var b strings.Builder
	fmt.Fprintf(&b, "order %s: %d bars, purchase=%d, cuts=%d (cut cost=%d), scrap=%d, remnant=%d, kerf loss=%d\n",
		p.OrderID, len(p.Bars), p.PurchaseCost, p.TotalCuts, p.CutCostTotal,
		p.TotalScrap, p.TotalRemnant, p.TotalKerfLoss)
	for _, bar := range p.Bars {
		fmt.Fprintf(&b, "bar %s (stock %d, %s):\n", bar.BarID, bar.StockLength, bar.Source)
		for i, pc := range bar.Pieces {
			fmt.Fprintf(&b, "  cut %d: %s len %d\n", i+1, pc.ID, pc.Length)
		}
		fmt.Fprintf(&b, "  cuts=%d kerf loss=%d", bar.Cuts, bar.KerfLoss)
		if bar.RemnantID != "" {
			fmt.Fprintf(&b, " remnant %d kept as %s", bar.Remnant, bar.RemnantID)
		}
		if bar.Scrap > 0 {
			fmt.Fprintf(&b, " scrap %d (below threshold)", bar.Scrap)
		}
		b.WriteString("\n")
	}
	b.WriteString("piece source tree:\n")
	for bi, bar := range p.Bars {
		last := bi == len(p.Bars)-1
		branch, vert := "+-", "| "
		if last {
			branch, vert = "`-", "  "
		}
		fmt.Fprintf(&b, "%s bar %s (stock %d)", branch, bar.BarID, bar.StockLength)
		if bar.Purchased {
			fmt.Fprintf(&b, " [purchased, cost %d]", bar.PurchaseCost)
		} else {
			fmt.Fprintf(&b, " <- %s", bar.Source)
		}
		b.WriteString("\n")
		for pi, pc := range bar.Pieces {
			leaf := "+-"
			if pi == len(bar.Pieces)-1 {
				leaf = "`-"
			}
			fmt.Fprintf(&b, "%s %s %s (len %d)\n", vert, leaf, pc.ID, pc.Length)
		}
	}
	fmt.Fprintf(&b, "conservation: stock %d = demand %d + kerf %d + remnant %d + scrap %d (ok=%v)\n",
		p.TotalStockLength, p.DemandLength, p.TotalKerfLoss, p.TotalRemnant, p.TotalScrap, p.ConservationOK)
	fmt.Fprintf(&b, "budget %d in [%d, %d]; purchase %d in [%d, %d]; cuts %d in [%d, %d]\n",
		p.Budget, p.Bounds.BudgetLower, p.Bounds.BudgetUpper,
		p.PurchaseCost, p.Bounds.PurchaseLower, p.Bounds.PurchaseUpper,
		p.TotalCuts, p.Bounds.CutsLower, p.Bounds.CutsUpper)
	return b.String()
}
