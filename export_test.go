package dataeng

import "os"

// appendFile writes raw bytes to the end of path, used to simulate a torn
// write in tests.
func appendFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(data)
	return err
}
