#pragma once

// dataeng: embeddable MySQL binlog assembly.
//
// The library turns a stream of raw MySQL binlog events into committed
// transactions.  It deliberately keeps "column was not present in this row
// image" separate from "column is SQL NULL": MINIMAL row images therefore
// produce Cell::Unknown() for absent columns and Cell::Null() only when the
// null bitmap actually says so.
//
// All state belongs to a BinlogAssembler instance.  Instances are cheap to
// embed in an existing replication client and do not use global mutable state
// (the CRC32 table is constant after initialisation).

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

inline constexpr std::size_t kEventHeaderSize = 19;

enum class EventType : std::uint8_t {
  Unknown = 0,
  StartEventV3 = 1,
  Query = 2,
  Stop = 3,
  Rotate = 4,
  Intvar = 5,
  Load = 6,
  Slave = 7,
  CreateFile = 8,
  AppendBlock = 9,
  ExecLoad = 10,
  DeleteFile = 11,
  NewLoad = 12,
  Rand = 13,
  UserVar = 14,
  FormatDescription = 15,
  Xid = 16,
  BeginLoadQuery = 17,
  ExecuteLoadQuery = 18,
  TableMap = 19,
  WriteRowsV0 = 20,
  UpdateRowsV0 = 21,
  DeleteRowsV0 = 22,
  WriteRowsV1 = 23,
  UpdateRowsV1 = 24,
  DeleteRowsV1 = 25,
  Incident = 26,
  Heartbeat = 27,
  Ignorable = 28,
  RowsQuery = 29,
  WriteRowsV2 = 30,
  UpdateRowsV2 = 31,
  DeleteRowsV2 = 32,
  Gtid = 33,
  AnonymousGtid = 34,
  PreviousGtids = 35,
  TransactionContext = 36,
  ViewChange = 37,
  XaPrepare = 38,
  PartialUpdateRows = 39,
  TransactionPayload = 40,
  HeartbeatV2 = 41,
  RowsQueryV2 = 42,

  QUERY_EVENT = Query,
  ROTATE_EVENT = Rotate,
  FORMAT_DESCRIPTION_EVENT = FormatDescription,
  XID_EVENT = Xid,
  TABLE_MAP_EVENT = TableMap,
  WRITE_ROWS_EVENT = WriteRowsV1,
  UPDATE_ROWS_EVENT = UpdateRowsV1,
  DELETE_ROWS_EVENT = DeleteRowsV1,
  WRITE_ROWS_EVENT_V1 = WriteRowsV1,
  UPDATE_ROWS_EVENT_V1 = UpdateRowsV1,
  DELETE_ROWS_EVENT_V1 = DeleteRowsV1,
  WRITE_ROWS_EVENT_V2 = WriteRowsV2,
  UPDATE_ROWS_EVENT_V2 = UpdateRowsV2,
  DELETE_ROWS_EVENT_V2 = DeleteRowsV2,
  GTID_EVENT = Gtid,
  ANONYMOUS_GTID_EVENT = AnonymousGtid,
  TRANSACTION_PAYLOAD_EVENT = TransactionPayload,
};

const char* event_type_name(EventType type) noexcept;
bool is_row_event(EventType type) noexcept;
bool is_write_rows_event(EventType type) noexcept;
bool is_update_rows_event(EventType type) noexcept;
bool is_delete_rows_event(EventType type) noexcept;

// Binlog coordinates.  `offset` is the exclusive end offset of an event, as
// carried in the binlog event header (log_pos).  When log_pos is unavailable
// (synthetic streams, nested transaction payloads) callers may leave it at 0.
struct BinlogPosition {
  std::string file;
  std::uint64_t offset = 0;

  bool empty() const noexcept { return file.empty() && offset == 0; }
  explicit operator bool() const noexcept { return !empty(); }
  std::string to_string() const;

  friend bool operator==(const BinlogPosition&, const BinlogPosition&) = default;
  friend auto operator<=>(const BinlogPosition&, const BinlogPosition&) = default;
};

struct EventHeader {
  std::uint32_t timestamp = 0;
  EventType type = EventType::Unknown;
  std::uint32_t server_id = 0;
  std::uint32_t event_size = 0;
  std::uint32_t log_pos = 0;
  std::uint16_t flags = 0;

  std::size_t payload_size() const noexcept {
    return event_size >= kEventHeaderSize ? event_size - kEventHeaderSize : 0;
  }
};

enum class ChecksumAlgorithm : std::uint8_t {
  Off = 0,
  Crc32 = 1,
  Auto = 0xff,
};

// MySQL's binlog checksum is the ordinary IEEE CRC-32 (the same polynomial as
// zlib).  Exposed so callers can build/inspect events without another
// dependency.
std::uint32_t binlog_crc32(std::span<const std::uint8_t> data) noexcept;

// MySQL column type byte values.  Only names that are useful to callers are
// listed; the raw byte is always available in ColumnDefinition::type.
enum class ColumnType : std::uint8_t {
  Decimal = 0,
  Tiny = 1,
  Short = 2,
  Long = 3,
  Float = 4,
  Double = 5,
  Null = 6,
  Timestamp = 7,
  LongLong = 8,
  Int24 = 9,
  Date = 10,
  Time = 11,
  DateTime = 12,
  Year = 13,
  NewDate = 14,
  VarChar = 15,
  Bit = 16,
  Timestamp2 = 17,
  DateTime2 = 18,
  Time2 = 19,
  Json = 245,
  NewDecimal = 246,
  Enum = 247,
  Set = 248,
  TinyBlob = 249,
  MediumBlob = 250,
  LongBlob = 251,
  Blob = 252,
  VarString = 253,
  String = 254,
  Geometry = 255,
};

struct ColumnDefinition {
  std::uint8_t type = 0;       // raw type from TABLE_MAP_EVENT
  std::uint8_t real_type = 0;  // resolved type (STRING may encode ENUM/SET)
  std::uint16_t metadata = 0;  // raw metadata word, interpreted per type
  std::uint16_t max_length = 0;
  std::uint8_t precision = 0;
  std::uint8_t scale = 0;
  std::uint8_t fractional_precision = 0;
  std::uint8_t length_bytes = 0;  // BLOB/JSON length prefix width
  bool nullable = false;
  bool is_unsigned = false;
  bool is_primary_key = false;
  std::string name;

  bool is_enum() const noexcept {
    return type == static_cast<std::uint8_t>(ColumnType::Enum) ||
           real_type == static_cast<std::uint8_t>(ColumnType::Enum);
  }
  bool is_set() const noexcept {
    return type == static_cast<std::uint8_t>(ColumnType::Set) ||
           real_type == static_cast<std::uint8_t>(ColumnType::Set);
  }
};

// A concrete table-id -> table definition mapping.  `generation` changes
// whenever a table id is (re)bound; consumers can retain a RowChange and trust
// that its embedded TableMap is the exact mapping that produced the row, even
// after the upstream table id is reused for another table.
struct TableMap {
  std::uint64_t table_id = 0;
  std::uint64_t generation = 0;
  std::string database;
  std::string table;
  std::vector<ColumnDefinition> columns;
  std::uint16_t flags = 0;
  std::uint32_t server_id = 0;
  BinlogPosition position;  // end position of the TABLE_MAP_EVENT
  bool has_optional_metadata = false;

  std::string qualified_name() const;
  const std::string& database_name() const noexcept { return database; }
  const std::string& table_name() const noexcept { return table; }
  std::size_t column_count() const noexcept { return columns.size(); }
};

using TableMapEvent = TableMap;

// A single decoded column value.  Unknown and Null are distinct on purpose.
struct Cell {
  enum class Kind : std::uint8_t {
    Unknown,   // column absent from a minimal row image; value not captured
    Missing = Unknown,
    Null,      // explicit SQL NULL
    Signed,
    Unsigned,
    Real,
    Decimal,
    String,
    Bytes,
    Bit,
    Date,
    Time,
    DateTime,
    Timestamp,
    Enum,
    Set,
    Json,
    Geometry,
  };

  using Type = Kind;

  Kind kind = Kind::Unknown;
  std::int64_t signed_value = 0;
  std::uint64_t unsigned_value = 0;
  double real_value = 0.0;
  std::uint32_t fractional_precision = 0;
  std::string text;                 // Decimal/String/Date/Time/DateTime/Enum/Set
  std::vector<std::uint8_t> bytes;  // Bytes/Bit/Json/Geometry

  static Cell unknown();
  static Cell null();
  static Cell from_signed(std::int64_t value);
  static Cell from_unsigned(std::uint64_t value);
  static Cell from_real(double value);
  static Cell from_decimal(std::string value, std::uint8_t scale = 0);
  static Cell from_string(std::string value);
  static Cell from_bytes(std::vector<std::uint8_t> value);
  static Cell from_bit(std::vector<std::uint8_t> value, std::uint32_t bits);
  static Cell from_date(std::string value);
  static Cell from_time(std::string value, std::uint32_t fractional_precision = 0);
  static Cell from_datetime(std::string value, std::uint32_t fractional_precision = 0);
  static Cell from_timestamp(std::uint64_t seconds, std::uint32_t fractional_precision = 0);
  static Cell from_timestamp(std::uint64_t seconds, std::uint32_t micros,
                             std::uint32_t fractional_precision);
  static Cell from_enum(std::string value, std::uint64_t index);
  static Cell from_set(std::string value, std::uint64_t mask);
  static Cell from_json(std::vector<std::uint8_t> value);
  static Cell from_geometry(std::vector<std::uint8_t> value);

  bool is_unknown() const noexcept { return kind == Kind::Unknown; }
  bool is_missing() const noexcept { return kind == Kind::Unknown; }
  bool is_null() const noexcept { return kind == Kind::Null; }
  bool is_null_or_unknown() const noexcept {
    return kind == Kind::Null || kind == Kind::Unknown;
  }
  bool has_value() const noexcept { return !is_null_or_unknown(); }
  bool is_numeric() const noexcept {
    return kind == Kind::Signed || kind == Kind::Unsigned || kind == Kind::Real ||
           kind == Kind::Decimal || kind == Kind::Enum || kind == Kind::Set;
  }
  bool is_text() const noexcept {
    return kind == Kind::String || kind == Kind::Decimal || kind == Kind::Date ||
           kind == Kind::Time || kind == Kind::DateTime || kind == Kind::Enum ||
           kind == Kind::Set;
  }

  std::int64_t as_signed() const;       // best-effort conversion
  std::uint64_t as_unsigned() const;    // best-effort conversion
  double as_double() const;             // best-effort conversion
  const std::string& as_string() const; // text form (empty for binary)
  std::string to_string() const;        // "unknown" / "null" / value
};

// One row image.  `columns` always has the same length as the TableMap that
// produced it.  `present[i]` is false when the image omitted column i; in that
// case columns[i] is Unknown, never Null.
struct RowImage {
  std::vector<Cell> columns;
  std::vector<bool> present;

  bool contains(std::size_t index) const noexcept {
    return index < present.size() && present[index];
  }
  bool missing(std::size_t index) const noexcept { return !contains(index); }
  bool unknown(std::size_t index) const noexcept {
    return index < columns.size() && columns[index].is_unknown();
  }
  bool is_complete() const noexcept;
  bool is_minimal() const noexcept { return !is_complete(); }
  std::size_t missing_count() const noexcept;
  std::size_t unknown_count() const noexcept;
  const Cell& at(std::size_t index) const;
  const Cell& value(std::size_t index) const { return at(index); }
  const Cell& column(std::size_t index) const { return at(index); }
  const Cell& operator[](std::size_t index) const { return at(index); }
  std::size_t size() const noexcept { return columns.size(); }
};

// Alias used by the CDC vocabulary in the requirements.
using MinimalRowImage = RowImage;

struct RowChange {
  enum class Kind : std::uint8_t {
    Insert = 1,
    Write = Insert,
    Update = 2,
    Delete = 3,
  };

  Kind kind = Kind::Insert;
  TableMap table;  // exact mapping snapshot (including generation)
  BinlogPosition position;
  std::uint32_t server_id = 0;
  RowImage before;  // Delete and Update
  RowImage after;   // Insert and Update

  std::uint64_t table_id() const noexcept { return table.table_id; }
  std::uint64_t table_generation() const noexcept { return table.generation; }
  const RowImage& before_image() const noexcept { return before; }
  const RowImage& after_image() const noexcept { return after; }
  // Insert -> after, Delete -> before, Update -> after.
  const RowImage& primary_image() const noexcept;
  bool is_minimal() const noexcept;
  std::string to_string() const;
};

using RowEvent = RowChange;
using ColumnValue = Cell;
using Value = Cell;
using Row = RowImage;

struct Gtid {
  std::string sid;  // canonical UUID, lower case
  std::uint64_t gno = 0;
  std::uint64_t last_committed = 0;
  std::uint64_t sequence_number = 0;
  std::int64_t immediate_commit_timestamp = 0;  // microseconds since epoch
  std::int64_t original_commit_timestamp = 0;
  std::uint64_t transaction_length = 0;
  bool is_anonymous = false;
  bool has_logical_timestamps = false;

  bool valid() const noexcept { return !sid.empty() || gno != 0; }
  std::string to_string() const;
};

using GtidEvent = Gtid;

struct Statement {
  std::string database;
  std::string query;
  std::uint32_t thread_id = 0;
  std::uint32_t error_code = 0;
  bool is_ddl = false;
};

struct Transaction {
  Gtid gtid;
  bool has_gtid = false;
  std::string database;
  std::vector<RowChange> changes;
  std::vector<Statement> statements;
  std::optional<std::uint64_t> xid;
  BinlogPosition begin_position;
  BinlogPosition commit_position;
  std::uint64_t event_count = 0;
  std::uint32_t server_id = 0;
  bool is_ddl = false;
  bool from_transaction_payload = false;

  bool empty() const noexcept { return changes.empty() && statements.empty(); }
  const std::vector<RowChange>& row_changes() const noexcept { return changes; }
  std::string to_string() const;
};

using Txn = Transaction;

enum class ErrorCode : std::uint8_t {
  None = 0,
  TruncatedEvent,
  InvalidEventSize,
  InvalidHeader,
  InvalidArgument,
  UnsupportedEvent,
  ChecksumMismatch,
  FormatDescriptionMissing,
  MalformedFormatDescription,
  MalformedTableMap,
  InvalidColumnMetadata,
  UnknownColumnType,
  UnknownTableId,
  StaleTableMap,
  ColumnCountMismatch,
  MalformedRowEvent,
  RowDataTruncated,
  MalformedGtid,
  MalformedQuery,
  MalformedXid,
  MalformedTransactionPayload,
  UnsupportedCompression,
  DecompressionFailed,
  NonMonotonicPosition,
  TransactionNotTerminated,
  StreamPoisoned,
  TrailingBytes,
};

const char* error_code_name(ErrorCode code) noexcept;

struct DecodeError {
  ErrorCode code = ErrorCode::None;
  std::string message;
  BinlogPosition position;
  EventType event_type = EventType::Unknown;

  std::string to_string() const;
};

struct FeedResult {
  bool ok = true;
  std::optional<DecodeError> error;
  bool event_accepted = false;
  bool position_advanced = false;  // the *safe* checkpoint moved
  BinlogPosition event_position;   // end of the accepted event, if any
  BinlogPosition checkpoint;       // safe resume point
  std::vector<Transaction> transactions;
  std::uint64_t events_processed = 0;

  explicit operator bool() const noexcept { return ok; }
};

struct AssemblerStats {
  std::uint64_t bytes = 0;
  std::uint64_t events = 0;
  std::uint64_t accepted_events = 0;
  std::uint64_t ignored_events = 0;
  std::uint64_t table_maps = 0;
  std::uint64_t row_events = 0;
  std::uint64_t rows = 0;
  std::uint64_t transactions = 0;
  std::uint64_t errors = 0;
};

struct AssemblerOptions {
  // Auto reads the checksum algorithm from FORMAT_DESCRIPTION_EVENT.  When a
  // stream starts without one, a matching trailing CRC32 is detected
  // heuristically; otherwise Auto behaves as Off.
  ChecksumAlgorithm checksum = ChecksumAlgorithm::Auto;
  bool verify_checksum = true;

  // Reject events whose log_pos moves backwards in the same file.
  bool reject_non_monotonic_positions = true;

  // A row event needs a TABLE_MAP_EVENT in the same file at or before the row
  // event position.  In relaxed mode the most recent binding is accepted even
  // if its position is newer (useful for synthetic streams); a completely
  // unknown table id is still fatal because values need typed columns.
  bool require_table_map = true;

  bool emit_empty_transactions = false;
  bool emit_statement_transactions = true;

  // TRANSACTION_PAYLOAD_EVENT support.  ZSTD is loaded dynamically; when the
  // runtime library is unavailable the event is rejected (never silently
  // advanced past).
  bool decompress_transaction_payload = true;

  // After a validation error, reject further input until reset()/recover().
  // This prevents a damaged event from being followed by an advance of the
  // safe checkpoint.
  bool stop_on_error = true;

  bool keep_table_map_history = true;
  std::size_t max_table_map_history = 32;
  bool allow_trailing_bytes = false;
};

// Streaming binlog assembler.
//
// Feed complete events (header + body, including the checksum bytes when the
// stream uses one) with push_event(), or a concatenation of events with
// push_events().  Committed transactions are returned in FeedResult and are
// also retained by take_completed_transactions() until drained.
class BinlogAssembler {
 public:
  explicit BinlogAssembler(AssemblerOptions options = {});
  ~BinlogAssembler();

  BinlogAssembler(BinlogAssembler&&) noexcept;
  BinlogAssembler& operator=(BinlogAssembler&&) noexcept;

  BinlogAssembler(const BinlogAssembler&) = delete;
  BinlogAssembler& operator=(const BinlogAssembler&) = delete;

  // `file` may be empty for synthetic streams.  It identifies the binlog file
  // containing the event; a non-empty change of file starts a new table-map
  // generation scope.
  FeedResult push_event(std::span<const std::uint8_t> event,
                        std::string_view file = {});
  FeedResult push_event(const std::uint8_t* data, std::size_t size,
                        std::string_view file = {}) {
    return push_event(std::span<const std::uint8_t>(data, size), file);
  }
  FeedResult push_event(std::string_view event, std::string_view file = {}) {
    return push_event(
        std::span<const std::uint8_t>(
            reinterpret_cast<const std::uint8_t*>(event.data()), event.size()),
        file);
  }
  FeedResult push_events(std::span<const std::uint8_t> events,
                         std::string_view file = {});
  FeedResult push_events(const std::uint8_t* data, std::size_t size,
                         std::string_view file = {}) {
    return push_events(std::span<const std::uint8_t>(data, size), file);
  }
  FeedResult push_events(std::string_view events, std::string_view file = {}) {
    return push_events(
        std::span<const std::uint8_t>(
            reinterpret_cast<const std::uint8_t*>(events.data()), events.size()),
        file);
  }
  FeedResult feed(std::span<const std::uint8_t> events,
                  std::string_view file = {}) {
    return push_events(events, file);
  }
  FeedResult feed(std::string_view events, std::string_view file = {}) {
    return push_events(events, file);
  }
  FeedResult feed(const std::uint8_t* data, std::size_t size,
                  std::string_view file = {}) {
    return push_events(data, size, file);
  }
  FeedResult push(std::span<const std::uint8_t> event,
                  std::string_view file = {}) {
    return push_event(event, file);
  }
  FeedResult push(std::string_view event, std::string_view file = {}) {
    return push_event(event, file);
  }

  // Records a ROTATE_EVENT when the caller consumes rotation out of band.
  FeedResult rotate(std::string next_file, std::uint64_t next_position);

  // Safe resume position: all preceding transactions are complete and every
  // accepted event was valid.  It never moves past a validation failure.
  BinlogPosition checkpoint() const;
  BinlogPosition safe_position() const { return checkpoint(); }
  // End of the last successfully validated event (may be ahead of checkpoint
  // while a transaction is still open).
  BinlogPosition last_position() const;

  bool in_transaction() const;
  bool poisoned() const;
  std::optional<DecodeError> last_error() const;

  ChecksumAlgorithm checksum_algorithm() const;
  void set_checksum_algorithm(ChecksumAlgorithm algorithm);

  // Current mapping for a table id (the most recently accepted map in the
  // active file scope), or nullptr.
  const TableMap* table_map(std::uint64_t table_id) const;
  // Mapping valid at the given position, including retained generations.
  const TableMap* table_map_at(std::uint64_t table_id,
                               const BinlogPosition& position) const;
  std::uint64_t table_map_generation(std::uint64_t table_id) const;

  std::vector<Transaction> take_completed_transactions();
  std::vector<Transaction> drain_transactions() {
    return take_completed_transactions();
  }
  const std::vector<Transaction>& completed_transactions() const;
  const std::vector<Transaction>& transactions() const {
    return completed_transactions();
  }
  const AssemblerStats& stats() const;

  const AssemblerOptions& options() const;
  void set_options(AssemblerOptions options);

  // Clears all stream state.  Use when starting a new binlog stream.
  void reset();
  // Clears the poisoned/error flag but keeps table maps and checkpoint, so a
  // caller can resynchronise at a known-good event boundary.
  void recover();
  // Discards the currently open (not yet committed) transaction.
  void discard_transaction();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

using Assembler = BinlogAssembler;
using BinlogDecoder = BinlogAssembler;

}  // namespace dataeng
