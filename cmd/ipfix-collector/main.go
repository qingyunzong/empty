// Command ipfix-collector is a reference host for the incremental ipfix
// receiver. Each accepted TCP connection gets its own receiver and template
// scope, so a reconnect never inherits the previous connection's templates.
package main

import (
	"flag"
	"io"
	"log"
	"net"
	"os"

	"example.org/dataeng/q0289/ipfix"
)

func main() {
	listenAddr := flag.String("listen", ":4739", "TCP address to listen on")
	maxMessage := flag.Int("max-message-bytes", ipfix.DefaultMaxMessageBytes, "maximum message length")
	maxFields := flag.Int("max-template-fields", ipfix.DefaultMaxTemplateFields, "maximum fields per template")
	maxTemplates := flag.Int("max-total-templates", ipfix.DefaultMaxTotalTemplates, "maximum templates per connection")
	maxRecords := flag.Int("max-message-records", ipfix.DefaultMaxMessageRecords, "maximum data records per message")
	flag.Parse()

	listener, err := net.Listen("tcp", *listenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", *listenAddr, err)
	}
	log.Printf("ipfix collector listening on %s", listener.Addr())

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handle(conn, ipfix.Limits{
			MaxMessageBytes:   *maxMessage,
			MaxTemplateFields: *maxFields,
			MaxTotalTemplates: *maxTemplates,
			MaxMessageRecords: *maxRecords,
		})
	}
}

func handle(conn net.Conn, limits ipfix.Limits) {
	defer conn.Close()

	identity := ipfix.ConnIdentity{
		LocalAddr:  conn.LocalAddr().String(),
		RemoteAddr: conn.RemoteAddr().String(),
	}
	receiver := ipfix.NewReceiver(identity, limits)
	logger := log.New(os.Stdout, "["+identity.RemoteAddr+"] ", log.LstdFlags)

	// A buffer larger than the message budget is pointless; keep Read chunks
	// bounded so a hostile sender cannot drive allocation.
	buf := make([]byte, 32*1024)
	if limits.MaxMessageBytes < len(buf) {
		buf = make([]byte, limits.MaxMessageBytes)
	}

	for {
		n, err := conn.Read(buf)
		if n > 0 {
			messages, decodeErr := receiver.Append(buf[:n])
			for _, message := range messages {
				publish(logger, message)
			}
			if decodeErr != nil {
				logger.Printf("receiver failed: %v; closing without frame resync", decodeErr)
				return
			}
		}
		if err == io.EOF {
			if endErr := receiver.EndInput(); endErr != nil {
				logger.Printf("truncated stream at EOF: %v", endErr)
			}
			return
		}
		if err != nil {
			logger.Printf("read: %v", err)
			return
		}
	}
}

func publish(logger *log.Logger, message ipfix.Message) {
	records := 0
	for _, set := range message.Sets {
		records += len(set.Records)
	}
	logger.Printf(
		"message domain=%d exportTime=%d sequence=%d sets=%d records=%d",
		message.ObservationDomain,
		message.ExportTime,
		message.Sequence,
		len(message.Sets),
		records,
	)
	for _, set := range message.Sets {
		for _, record := range set.Records {
			logger.Printf("  set=%d template=%d fields=%d", set.ID, record.TemplateID, len(record.Fields))
		}
	}
}
