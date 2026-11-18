package formal

import "fmt"

// cauchyCoefficients builds the m x k Cauchy parity matrix
//
//	C[i][j] = 1 / (x_i + y_j)
//
// with x_i = i and y_j = m+j.  Addition is XOR in GF(2^8).  Because all x_i
// are distinct, all y_j are distinct and x_i != y_j, every square submatrix of
// C is non-singular.  Consequently the systematic generator [I | C] is MDS:
// every selection of k rows is invertible.
func cauchyCoefficients(dataShards, parityShards int) [][]byte {
	matrix := make([][]byte, parityShards)
	for i := 0; i < parityShards; i++ {
		matrix[i] = make([]byte, dataShards)
		x := byte(i)
		for j := 0; j < dataShards; j++ {
			y := byte(parityShards + j)
			matrix[i][j] = gfInv(x ^ y)
		}
	}
	return matrix
}

// generatorRow returns row r of the systematic n x k generator matrix.
func (c *Codec) generatorRow(row int) []byte {
	out := make([]byte, c.dataShards)
	if row < c.dataShards {
		out[row] = 1
		return out
	}
	copy(out, c.parityCoefficients[row-c.dataShards])
	return out
}

// invertMatrix returns the inverse of a square matrix over GF(2^8) using
// Gauss-Jordan elimination.
func invertMatrix(matrix [][]byte) ([][]byte, error) {
	n := len(matrix)
	if n == 0 {
		return nil, fmt.Errorf("formal: cannot invert an empty matrix")
	}

	augmented := make([][]byte, n)
	for i := 0; i < n; i++ {
		if len(matrix[i]) != n {
			return nil, fmt.Errorf("formal: matrix is not square: row %d has %d entries", i, len(matrix[i]))
		}
		augmented[i] = make([]byte, 2*n)
		copy(augmented[i], matrix[i])
		augmented[i][n+i] = 1
	}

	for col := 0; col < n; col++ {
		pivot := -1
		for row := col; row < n; row++ {
			if augmented[row][col] != 0 {
				pivot = row
				break
			}
		}
		if pivot < 0 {
			return nil, fmt.Errorf("formal: singular matrix at column %d", col)
		}
		if pivot != col {
			augmented[col], augmented[pivot] = augmented[pivot], augmented[col]
		}

		if scale := augmented[col][col]; scale != 1 {
			inverse := gfInv(scale)
			for j := col; j < 2*n; j++ {
				augmented[col][j] = gfMul(augmented[col][j], inverse)
			}
		}

		for row := 0; row < n; row++ {
			if row == col {
				continue
			}
			factor := augmented[row][col]
			if factor == 0 {
				continue
			}
			for j := col; j < 2*n; j++ {
				augmented[row][j] ^= gfMul(factor, augmented[col][j])
			}
		}
	}

	inverse := make([][]byte, n)
	for i := 0; i < n; i++ {
		inverse[i] = append([]byte(nil), augmented[i][n:]...)
	}
	return inverse, nil
}
