#include "dataeng.hpp"

#include <cassert>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using Bytes = std::vector<std::uint8_t>;

void put_u16(Bytes& out, std::uint16_t v) {
  out.push_back(static_cast<std::uint8_t>(v & 0xff));
  out.push_back(static_cast<std::uint8_t>((v >> 8) & 0xff));
}

void put_u24(Bytes& out, std::uint32_t v) {
  for (int i = 0; i < 3; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_u32(Bytes& out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_u48(Bytes& out, std::uint64_t v) {
  for (int i = 0; i < 6; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_u64(Bytes& out, std::uint64_t v) {
  for (int i = 0; i < 8; ++i) out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
}

void put_u64be(Bytes& out, std::uint64_t v, int width) {
  for (int i = width - 1; i >= 0; --i) {
    out.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xff));
  }
}

void put_lenenc(Bytes& out, std::uint64_t v) {
  if (v < 251) {
    out.push_back(static_cast<std::uint8_t>(v));
  } else if (v <= 0xffff) {
    out.push_back(0xfc);
    put_u16(out, static_cast<std::uint16_t>(v));
  } else if (v <= 0xffffff) {
    out.push_back(0xfd);
    put_u24(out, static_cast<std::uint32_t>(v));
  } else {
    out.push_back(0xfe);
    put_u64(out, v);
  }
}

void put_str(Bytes& out, std::string_view s) {
  out.insert(out.end(), s.begin(), s.end());
}

Bytes build_event(std::uint8_t type, const Bytes& body, std::uint32_t log_pos,
                  bool with_crc) {
  Bytes event;
  put_u32(event, 0);  // timestamp
  event.push_back(type);
  put_u32(event, 7);  // server id
  put_u32(event, static_cast<std::uint32_t>(19 + body.size() + (with_crc ? 4 : 0)));
  put_u32(event, log_pos);
  put_u16(event, 0);
  assert(event.size() == 19);
  event.insert(event.end(), body.begin(), body.end());
  if (with_crc) {
    const std::uint32_t crc = dataeng::binlog_crc32(event);
    put_u32(event, crc);
  }
  return event;
}

struct StreamBuilder {
  bool crc = false;
  std::uint32_t pos = 0;
  Bytes data;

  void add(std::uint8_t type, const Bytes& body) {
    const std::uint32_t size =
        static_cast<std::uint32_t>(19 + body.size() + (crc ? 4 : 0));
    pos += size;
    Bytes event = build_event(type, body, pos, crc);
    data.insert(data.end(), event.begin(), event.end());
  }

  void add_raw(const Bytes& event) { data.insert(data.end(), event.begin(), event.end()); }
};

Bytes fde_body(bool crc) {
  Bytes body;
  put_u16(body, 4);
  std::string server = "8.0.36";
  server.resize(50, '\0');
  put_str(body, server);
  put_u32(body, 0);
  body.push_back(19);
  body.push_back(crc ? 1 : 0);  // checksum algorithm descriptor
  return body;
}

Bytes gtid_body(std::uint64_t gno) {
  Bytes body;
  body.push_back(0);  // flags
  for (int i = 0; i < 16; ++i) body.push_back(static_cast<std::uint8_t>(i + 1));
  put_u64(body, gno);
  body.push_back(2);  // logical timestamp type
  put_u64(body, gno - 1);
  put_u64(body, gno);
  put_u64be(body, 1700000000000000ull, 7);
  put_u64be(body, 1700000000000000ull, 7);
  put_lenenc(body, 100);
  put_u32(body, 80036);
  put_u32(body, 80036);
  return body;
}

Bytes query_body(std::string_view db, std::string_view sql) {
  Bytes body;
  put_u32(body, 1);  // thread id
  put_u32(body, 0);  // exec time
  body.push_back(static_cast<std::uint8_t>(db.size()));
  put_u16(body, 0);  // error code
  put_u16(body, 0);  // status vars length
  put_str(body, db);
  put_str(body, sql);
  return body;
}

struct ColumnSpec {
  std::uint8_t type;
  Bytes metadata;
  bool nullable = false;
};

Bytes table_map_body(std::uint64_t table_id, std::string_view db, std::string_view table,
                     const std::vector<ColumnSpec>& columns,
                     const Bytes& optional_metadata = {}) {
  Bytes body;
  put_u48(body, table_id);
  put_u16(body, 0);  // flags
  body.push_back(static_cast<std::uint8_t>(db.size()));
  put_str(body, db);
  body.push_back(static_cast<std::uint8_t>(table.size()));
  put_str(body, table);
  put_lenenc(body, columns.size());
  Bytes metadata;
  for (const auto& column : columns) {
    body.push_back(column.type);
    metadata.insert(metadata.end(), column.metadata.begin(), column.metadata.end());
  }
  put_lenenc(body, metadata.size());
  body.insert(body.end(), metadata.begin(), metadata.end());
  Bytes nulls((columns.size() + 7) / 8, 0);
  for (std::size_t i = 0; i < columns.size(); ++i) {
    if (columns[i].nullable) nulls[i / 8] |= static_cast<std::uint8_t>(1u << (i % 8));
  }
  body.insert(body.end(), nulls.begin(), nulls.end());
  body.insert(body.end(), optional_metadata.begin(), optional_metadata.end());
  return body;
}

Bytes optional_column_metadata() {
  Bytes out;
  // FIELD_TYPE_SIGNEDNESS: one byte per column, 1 means unsigned.
  out.push_back(1);
  put_lenenc(out, 3);
  out.push_back(0);
  out.push_back(0);
  out.push_back(1);

  // FIELD_TYPE_COLUMN_NAME: length-encoded names.
  Bytes names;
  put_lenenc(names, 2);
  put_str(names, "id");
  put_lenenc(names, 4);
  put_str(names, "name");
  put_lenenc(names, 5);
  put_str(names, "score");
  out.push_back(4);
  put_lenenc(out, names.size());
  out.insert(out.end(), names.begin(), names.end());

  // FIELD_TYPE_SIMPLE_PRIMARY_KEY: column 0.
  out.push_back(8);
  put_lenenc(out, 1);
  out.push_back(0);
  return out;
}

std::vector<ColumnSpec> sample_columns() {
  return {
      {3, {}, false},               // id INT NOT NULL
      {15, {0xff, 0x00}, true},     // name VARCHAR(255) NULL
      {3, {}, true},                // score INT NULL
  };
}

Bytes row_event_v1(std::uint8_t type, std::uint64_t table_id, std::size_t column_count,
                   const std::vector<std::uint8_t>& bitmaps, const Bytes& row_data) {
  Bytes body;
  put_u48(body, table_id);
  put_u16(body, 0);  // flags
  put_lenenc(body, column_count);
  for (std::uint8_t bitmap : bitmaps) body.push_back(bitmap);
  body.insert(body.end(), row_data.begin(), row_data.end());
  return body;
}

Bytes row_event_v2(std::uint8_t type, std::uint64_t table_id, std::size_t column_count,
                   const std::vector<std::uint8_t>& bitmaps, const Bytes& row_data) {
  Bytes body;
  put_u48(body, table_id);
  put_u16(body, 0);  // flags
  put_u16(body, 0);  // extra data length
  put_lenenc(body, column_count);
  for (std::uint8_t bitmap : bitmaps) body.push_back(bitmap);
  body.insert(body.end(), row_data.begin(), row_data.end());
  return body;
}

Bytes row_event_v0(std::uint8_t type, std::uint64_t table_id, std::size_t column_count,
                   const std::vector<std::uint8_t>& bitmaps, const Bytes& row_data) {
  Bytes body;
  put_u32(body, static_cast<std::uint32_t>(table_id));
  put_u16(body, 0);  // flags
  put_lenenc(body, column_count);
  for (std::uint8_t bitmap : bitmaps) body.push_back(bitmap);
  body.insert(body.end(), row_data.begin(), row_data.end());
  return body;
}

Bytes rows_full_insert() {
  // id=10, name="abc", score=42
  Bytes rows;
  rows.push_back(0);  // null bitmap: nothing null
  put_u32(rows, 10);
  rows.push_back(3);
  put_str(rows, "abc");
  put_u32(rows, 42);
  return rows;
}

Bytes rows_partial_insert() {
  // present columns {0, 2}; column 2 is NULL, column 1 must stay unknown.
  Bytes rows;
  rows.push_back(0x02);  // null bitmap over present ordinals: ordinal 1 (col 2) is null
  put_u32(rows, 10);
  return rows;
}

Bytes rows_minimal_update() {
  // before: id=10 (only column 0 present); after: score=99 (only column 2 present)
  Bytes rows;
  rows.push_back(0);  // before null bitmap
  put_u32(rows, 10);
  rows.push_back(0);  // after null bitmap
  put_u32(rows, 99);
  return rows;
}

Bytes xid_body(std::uint64_t xid) {
  Bytes body;
  put_u64(body, xid);
  return body;
}

Bytes rotate_body(std::uint64_t next_position, std::string_view next_file) {
  Bytes body;
  put_u64(body, next_position);
  put_str(body, next_file);
  return body;
}

void append_begin(StreamBuilder& stream) {
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Query),
             query_body("app", "BEGIN"));
}

void append_write(StreamBuilder& stream, std::uint64_t table_id,
                  const std::vector<std::uint8_t>& bitmaps, const Bytes& rows) {
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1),
                          table_id, 3, bitmaps, rows));
}

void append_update(StreamBuilder& stream, std::uint64_t table_id,
                   const std::vector<std::uint8_t>& bitmaps, const Bytes& rows) {
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::UpdateRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::UpdateRowsV1),
                          table_id, 3, bitmaps, rows));
}

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

dataeng::FeedResult feed_one(dataeng::BinlogAssembler& assembler, const Bytes& event,
                             const std::string& file = {}) {
  return assembler.push_event(event, file);
}

void test_full_rows_and_transaction() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(101));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(1, "app", "users", sample_columns()));
  append_write(stream, 1, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(55));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "full transaction should parse: " +
                         (result.error ? result.error->to_string() : ""));
  require(result.transactions.size() == 1, "one transaction expected");
  const auto& txn = result.transactions.front();
  require(txn.has_gtid, "GTID should be attached");
  require(txn.gtid.gno == 101, "GTID gno");
  require(txn.changes.size() == 1, "one row change");
  const auto& change = txn.changes.front();
  require(change.kind == dataeng::RowChange::Kind::Insert, "insert kind");
  require(change.after.columns.size() == 3, "three columns");
  require(!change.after.columns[0].is_unknown() && change.after.columns[0].as_signed() == 10,
          "id decoded");
  require(change.after.columns[1].as_string() == "abc", "name decoded");
  require(change.after.columns[2].as_signed() == 42, "score decoded");
  require(change.table.table == "users" && change.table.database == "app", "table name");
  require(change.table.generation != 0, "generation assigned");
  require(assembler.checkpoint().offset == stream.pos, "checkpoint at XID end");
}

void test_unknown_is_not_null() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(102));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(2, "app", "users", sample_columns()));
  append_write(stream, 2, {0x05}, rows_partial_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(56));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "partial insert should parse");
  const auto& change = result.transactions.at(0).changes.at(0);
  require(change.after.contains(0) && change.after.contains(2), "present bitmap");
  require(!change.after.contains(1), "column 1 absent");
  require(change.after.columns[1].is_unknown(), "absent column is unknown");
  require(!change.after.columns[1].is_null(), "absent column is not null");
  require(change.after.columns[2].is_null(), "explicit null preserved");
  require(change.is_minimal(), "change should be marked minimal");
}

void test_minimal_update_images() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(103));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(3, "app", "users", sample_columns()));
  append_update(stream, 3, {0x01, 0x04}, rows_minimal_update());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(57));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "minimal update should parse");
  const auto& change = result.transactions.at(0).changes.at(0);
  require(change.kind == dataeng::RowChange::Kind::Update, "update kind");
  require(change.before.columns[0].as_signed() == 10, "before id");
  require(change.before.columns[1].is_unknown(), "before missing name unknown");
  require(change.before.columns[2].is_unknown(), "before missing score unknown");
  require(change.after.columns[0].is_unknown(), "after missing id unknown");
  require(change.after.columns[1].is_unknown(), "after missing name unknown");
  require(change.after.columns[2].as_signed() == 99, "after score");
  require(!change.before.is_complete() && !change.after.is_complete(),
          "both images are minimal");
}

void test_table_id_reuse_generations() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(110));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(9, "app", "first", sample_columns()));
  append_write(stream, 9, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(60));

  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(111));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(9, "app", "second", sample_columns()));
  append_write(stream, 9, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(61));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "reuse stream should parse");
  require(result.transactions.size() == 2, "two transactions");
  const auto& first = result.transactions[0].changes.at(0);
  const auto& second = result.transactions[1].changes.at(0);
  require(first.table.table == "first", "first mapping snapshot");
  require(second.table.table == "second", "second mapping snapshot");
  require(first.table.generation != second.table.generation,
          "reused table id must have distinct generations");
}

void test_table_map_lookup_by_position() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(112));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(31, "app", "alpha", sample_columns()));
  append_write(stream, 31, {0x07}, rows_full_insert());
  const std::uint32_t first_row_pos = stream.pos;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(62));

  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(113));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(31, "app", "beta", sample_columns()));
  const std::uint32_t second_map_pos = stream.pos;
  append_write(stream, 31, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(63));

  auto result = assembler.push_events(stream.data, "binlog.000009");
  require(result.ok, "position lookup stream parses");
  const dataeng::TableMap* at_first =
      assembler.table_map_at(31, {"binlog.000009", first_row_pos});
  const dataeng::TableMap* at_second =
      assembler.table_map_at(31, {"binlog.000009", second_map_pos});
  const dataeng::TableMap* before = assembler.table_map_at(31, {"binlog.000009", 1});
  require(at_first && at_first->table == "alpha", "lookup resolves old generation");
  require(at_second && at_second->table == "beta", "lookup resolves new generation");
  require(before == nullptr, "lookup before the first map returns null");
  require(at_first->generation < at_second->generation, "lookup generations ordered");
}

void test_checksum_failure_keeps_checkpoint_and_prior_transaction() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.crc = true;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::FormatDescription),
             fde_body(true));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(120));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(4, "app", "users", sample_columns()));
  append_write(stream, 4, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(70));

  auto first = assembler.push_events(stream.data);
  require(first.ok, "first transaction with CRC should parse: " +
                        (first.error ? first.error->to_string() : ""));
  require(first.transactions.size() == 1, "first transaction delivered");
  const auto checkpoint_before = assembler.checkpoint();
  require(checkpoint_before.offset == stream.pos, "checkpoint at first XID");

  // A second transaction whose CRC is deliberately corrupted.
  StreamBuilder bad;
  bad.crc = true;
  bad.pos = static_cast<std::uint32_t>(checkpoint_before.offset);
  bad.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(121));
  append_begin(bad);
  bad.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
          table_map_body(5, "app", "users", sample_columns()));
  bad.data[bad.data.size() - 1] ^= 0xff;  // damage CRC (last byte of event)

  auto second = assembler.push_events(bad.data);
  require(!second.ok, "corrupt event must be rejected");
  require(second.error && second.error->code == dataeng::ErrorCode::ChecksumMismatch,
          "checksum error expected");
  require(!second.position_advanced, "checkpoint must not advance");
  require(assembler.checkpoint() == checkpoint_before, "checkpoint unchanged");
  require(assembler.poisoned(), "assembler poisoned");
  auto retained = assembler.take_completed_transactions();
  require(retained.size() == 1 && retained.at(0).gtid.gno == 120,
          "the preceding complete transaction remains deliverable");
}

void test_batch_failure_delivers_preceding_transaction() {
  StreamBuilder good;
  good.crc = true;
  good.add(static_cast<std::uint8_t>(dataeng::EventType::FormatDescription),
           fde_body(true));
  good.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(125));
  append_begin(good);
  good.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
           table_map_body(41, "app", "users", sample_columns()));
  append_write(good, 41, {0x07}, rows_full_insert());
  good.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(75));

  dataeng::BinlogAssembler assembler;
  auto first = assembler.push_events(good.data);
  require(first.ok && first.transactions.size() == 1, "good transaction first");
  const auto good_checkpoint = assembler.checkpoint();

  // A batch that contains one complete transaction followed by a damaged
  // event: the complete one is deliverable, the checkpoint stops at its end.
  StreamBuilder batch;
  batch.crc = true;
  batch.pos = static_cast<std::uint32_t>(good_checkpoint.offset);
  batch.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(126));
  append_begin(batch);
  batch.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(42, "app", "users", sample_columns()));
  append_write(batch, 42, {0x07}, rows_full_insert());
  batch.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(76));
  batch.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(127));
  batch.data[batch.data.size() - 1] ^= 0x5a;

  auto result = assembler.push_events(batch.data);
  require(!result.ok, "batch with damaged final event fails");
  require(result.error && result.error->code == dataeng::ErrorCode::ChecksumMismatch,
          "checksum failure");
  require(result.transactions.size() == 1 && result.transactions[0].gtid.gno == 126,
          "complete transaction before the damaged event is delivered");
  require(result.position_advanced, "checkpoint advanced to the complete transaction");
  require(assembler.checkpoint() == result.transactions[0].commit_position,
          "checkpoint stops at the complete transaction");
}

void test_missing_table_map_fails_without_advancing() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(130));
  append_begin(stream);
  append_write(stream, 77, {0x07}, rows_full_insert());

  auto result = assembler.push_events(stream.data);
  require(!result.ok, "missing table map must fail");
  require(result.error && result.error->code == dataeng::ErrorCode::UnknownTableId,
          "UnknownTableId expected");
  require(assembler.checkpoint().offset == 0, "checkpoint did not advance into transaction");
}

void test_rotate_clears_table_maps_but_generations_continue() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder first;
  first.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(140));
  append_begin(first);
  first.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(1, "app", "old", sample_columns()));
  append_write(first, 1, {0x07}, rows_full_insert());
  first.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(80));
  auto r1 = assembler.push_events(first.data, "binlog.000001");
  require(r1.ok, "first file parses");
  const std::uint64_t old_generation = r1.transactions.at(0).changes.at(0).table.generation;

  auto rotation = assembler.rotate("binlog.000002", 4);
  require(rotation.ok, "rotate");
  require(assembler.table_map(1) == nullptr, "table map scope cleared");

  StreamBuilder second;
  second.pos = 4;
  second.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(141));
  append_begin(second);
  second.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(1, "app", "new", sample_columns()));
  append_write(second, 1, {0x07}, rows_full_insert());
  second.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(81));
  auto r2 = assembler.push_events(second.data, "binlog.000002");
  require(r2.ok, "second file parses");
  const auto& change = r2.transactions.at(0).changes.at(0);
  require(change.table.table == "new", "new table mapping");
  require(change.table.generation > old_generation, "generation continues across files");
}

void test_rotate_event_updates_file_position() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder first;
  first.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(142));
  append_begin(first);
  first.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(1, "app", "old", sample_columns()));
  append_write(first, 1, {0x07}, rows_full_insert());
  first.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(82));
  first.add(static_cast<std::uint8_t>(dataeng::EventType::Rotate),
            rotate_body(4, "binlog.000004"));
  auto r1 = assembler.push_events(first.data, "binlog.000003");
  require(r1.ok, "rotate event parses: " +
                     (r1.error ? r1.error->to_string() : ""));
  require(assembler.last_position().file == "binlog.000004" &&
              assembler.last_position().offset == 4,
          "rotate moves stream position to the next file");
  require(assembler.checkpoint().file == "binlog.000004" &&
              assembler.checkpoint().offset == 4,
          "rotate checkpoint at next file start");
}

Bytes transaction_payload_body(const Bytes& nested) {
  Bytes body;
  put_lenenc(body, nested.size());
  body.push_back(255);  // no compression
  put_lenenc(body, nested.size());
  body.insert(body.end(), nested.begin(), nested.end());
  return body;
}

void test_transaction_payload_none() {
  StreamBuilder inner;
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(6, "app", "payload", sample_columns()));
  append_write(inner, 6, {0x07}, rows_full_insert());
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(90));

  dataeng::BinlogAssembler assembler;
  StreamBuilder outer;
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(150));
  append_begin(outer);
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::TransactionPayload),
            transaction_payload_body(inner.data));
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(91));

  auto result = assembler.push_events(outer.data);
  require(result.ok, "transaction payload should parse: " +
                         (result.error ? result.error->to_string() : ""));
  require(result.transactions.size() == 1, "one transaction from payload");
  require(result.transactions.at(0).changes.size() == 1, "row change from payload");
  require(result.transactions.at(0).changes.at(0).table.table == "payload",
          "payload table map");
  require(assembler.checkpoint().offset == outer.pos, "checkpoint at outer XID");
}

void test_transaction_payload_without_inner_xid() {
  StreamBuilder inner;
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(18, "app", "payload2", sample_columns()));
  append_write(inner, 18, {0x07}, rows_full_insert());

  dataeng::BinlogAssembler assembler;
  StreamBuilder outer;
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(155));
  append_begin(outer);
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::TransactionPayload),
            transaction_payload_body(inner.data));
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(93));

  auto result = assembler.push_events(outer.data);
  require(result.ok, "payload without inner XID parses: " +
                         (result.error ? result.error->to_string() : ""));
  require(result.transactions.size() == 1, "outer XID commits payload transaction");
  require(result.transactions.at(0).commit_position.offset == outer.pos,
          "commit position is the outer XID");
  require(result.transactions.at(0).xid && *result.transactions.at(0).xid == 93,
          "outer XID attached to payload transaction");
}

void test_transaction_payload_failure_is_atomic() {
  StreamBuilder inner;
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(7, "app", "payload", sample_columns()));
  append_write(inner, 7, {0x07}, rows_full_insert());
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(92));
  // Append a truncated nested event.
  inner.data.push_back(0xfe);

  dataeng::BinlogAssembler assembler;
  StreamBuilder outer;
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(151));
  append_begin(outer);
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::TransactionPayload),
            transaction_payload_body(inner.data));

  const auto before = assembler.checkpoint();
  auto result = assembler.push_events(outer.data);
  require(!result.ok, "damaged payload must fail");
  require(result.transactions.empty(), "inner commit must be rolled back");
  require(assembler.checkpoint() == before, "checkpoint not advanced");
  require(assembler.take_completed_transactions().empty(), "nothing delivered");
  require(assembler.table_map(7) == nullptr, "failed payload table map rolled back");
}

void test_statement_transaction_and_ddl() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Query),
             query_body("app", "CREATE TABLE t (id INT)"));
  auto result = assembler.push_events(stream.data);
  require(result.ok, "DDL query parses");
  require(result.transactions.size() == 1, "DDL transaction delivered");
  require(result.transactions.at(0).is_ddl, "DDL flagged");
  require(result.transactions.at(0).statements.at(0).query.find("CREATE") == 0,
          "statement text retained");
}

void test_gtid_statement_autocommit() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(161));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Query),
             query_body("app", "CREATE TABLE t (id INT)"));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(162));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Query),
             query_body("app", "INSERT INTO t VALUES (1)"));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "statement autocommit parses: " +
                         (result.error ? result.error->to_string() : ""));
  require(result.transactions.size() == 2, "two statement transactions");
  require(result.transactions[0].has_gtid && result.transactions[0].gtid.gno == 161,
          "DDL keeps its GTID");
  require(result.transactions[0].is_ddl, "DDL flagged");
  require(result.transactions[1].has_gtid && result.transactions[1].gtid.gno == 162,
          "DML keeps its GTID");
  require(result.transactions[1].statements.size() == 1, "DML statement retained");
}

void test_checksum_off_fde() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;  // CRC disabled
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::FormatDescription),
             fde_body(false));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(160));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(11, "app", "users", sample_columns()));
  append_write(stream, 11, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(95));
  auto result = assembler.push_events(stream.data);
  require(result.ok, "checksum-off stream parses: " +
                         (result.error ? result.error->to_string() : ""));
  require(assembler.checksum_algorithm() == dataeng::ChecksumAlgorithm::Off,
          "checksum algorithm from FDE");
}

void test_crc_without_fde_is_detected() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.crc = true;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(165));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(15, "app", "users", sample_columns()));
  append_write(stream, 15, {0x07}, rows_full_insert());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(94));
  auto result = assembler.push_events(stream.data);
  require(result.ok, "CRC without FDE parses: " +
                         (result.error ? result.error->to_string() : ""));
  require(assembler.checksum_algorithm() == dataeng::ChecksumAlgorithm::Crc32,
          "CRC32 detected");
}

void test_v2_rows_multi_row_and_delete() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(170));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(12, "app", "users", sample_columns()));

  Bytes two_rows = rows_full_insert();
  Bytes second = rows_full_insert();
  second[1] = 11;  // id = 11 (index 0 is the null bitmap)
  two_rows.insert(two_rows.end(), second.begin(), second.end());
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV2),
             row_event_v2(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV2), 12, 3,
                          {0x07}, two_rows));

  // Delete row: before image only contains id.
  Bytes delete_row;
  delete_row.push_back(0);
  put_u32(delete_row, 11);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::DeleteRowsV2),
             row_event_v2(static_cast<std::uint8_t>(dataeng::EventType::DeleteRowsV2), 12, 3,
                          {0x01}, delete_row));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(96));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "v2 row events parse: " +
                         (result.error ? result.error->to_string() : ""));
  const auto& changes = result.transactions.at(0).changes;
  require(changes.size() == 3, "two inserts and one delete");
  require(changes[0].kind == dataeng::RowChange::Kind::Insert, "insert 1");
  require(changes[1].kind == dataeng::RowChange::Kind::Insert, "insert 2");
  require(changes[1].after.columns[0].as_signed() == 11, "second row id");
  require(changes[2].kind == dataeng::RowChange::Kind::Delete, "delete");
  require(changes[2].before.columns[0].as_signed() == 11, "delete before image");
  require(changes[2].before.columns[1].is_unknown(), "delete absent name unknown");
}

void test_v0_rows_and_full_update() {
  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(175));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(17, "app", "users", sample_columns()));

  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV0),
             row_event_v0(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV0), 17, 3,
                          {0x07}, rows_full_insert()));

  Bytes update_rows;
  update_rows.push_back(0);
  put_u32(update_rows, 10);
  update_rows.push_back(3);
  put_str(update_rows, "def");
  put_u32(update_rows, 43);
  update_rows.push_back(0x04);  // after image: score is NULL
  put_u32(update_rows, 10);
  update_rows.push_back(3);
  put_str(update_rows, "def");

  stream.add(static_cast<std::uint8_t>(dataeng::EventType::UpdateRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::UpdateRowsV1), 17, 3,
                          {0x07, 0x07}, update_rows));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(101));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "v0 and full update parse: " +
                         (result.error ? result.error->to_string() : ""));
  const auto& changes = result.transactions.at(0).changes;
  require(changes.size() == 2, "insert plus update");
  require(changes[0].after.is_complete(), "v0 full insert image");
  require(changes[1].kind == dataeng::RowChange::Kind::Update, "update kind");
  require(changes[1].before.is_complete() && changes[1].after.is_complete(),
          "full update images");
  require(changes[1].after.columns[1].as_string() == "def", "updated name");
  require(changes[1].after.columns[2].is_null(), "updated null score");
  require(!changes[1].is_minimal(), "full update is not minimal");
}

void test_decimal_and_temporal_values() {
  std::vector<ColumnSpec> columns = {
      {246, {10, 2}, false},  // DECIMAL(10,2)
      {18, {3}, false},       // DATETIME(3)
      {19, {3}, false},       // TIME(3)
      {17, {3}, false},       // TIMESTAMP(3)
      {10, {}, false},        // DATE
      {13, {}, false},        // YEAR
  };

  Bytes rows;
  rows.push_back(0);  // no nulls
  // -1234.56: two's complement of 80 00 04 D2 38
  const std::uint8_t decimal_negative[] = {0x7f, 0xff, 0xfb, 0x2d, 0xc8};
  rows.insert(rows.end(), std::begin(decimal_negative), std::end(decimal_negative));
  // DATETIME2 2024-11-16 12:34:56.789
  const std::uint64_t dt_packed =
      ((static_cast<std::uint64_t>(2024 * 13 + 11) << 22) | (16ull << 17) | (12ull << 12) |
       (34ull << 6) | 56ull) +
      0x8000000000ull;
  put_u64be(rows, dt_packed, 5);
  put_u64be(rows, 789, 2);
  // TIME2 12:34:56.789
  const std::uint32_t time_packed = (12u << 12) | (34u << 6) | 56u;
  put_u64be(rows, time_packed + 0x800000u, 3);
  put_u64be(rows, 789, 2);
  // TIMESTAMP2 2023-11-14 22:13:20 UTC + .789
  put_u64be(rows, 1700000000ull, 4);
  put_u64be(rows, 789, 2);
  // DATE 2024-11-16
  put_u24(rows, (2024u << 9) | (11u << 5) | 16u);
  rows.push_back(124);  // YEAR 2024 (1900 + 124)

  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(180));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(13, "app", "types", columns));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1), 13,
                          columns.size(), {0x3f}, rows));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(97));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "typed row parses: " +
                         (result.error ? result.error->to_string() : ""));
  const auto& image = result.transactions.at(0).changes.at(0).after;
  require(image.columns[0].kind == dataeng::Cell::Kind::Decimal, "decimal kind");
  require(image.columns[0].as_string() == "-1234.56", "negative decimal");
  require(image.columns[1].as_string() == "2024-11-16 12:34:56.789",
          "datetime2: got '" + image.columns[1].as_string() + "'");
  require(image.columns[2].as_string() == "12:34:56.789", "time2");
  require(image.columns[3].as_string() == "2023-11-14 22:13:20.789", "timestamp2");
  require(image.columns[4].as_string() == "2024-11-16", "date");
  require(image.columns[5].as_signed() == 2024, "year");
}

void test_optional_table_metadata_and_unsigned() {
  Bytes rows;
  rows.push_back(0);
  put_u32(rows, 10);
  rows.push_back(1);
  put_str(rows, "x");
  put_u32(rows, 4000000000u);  // > INT32_MAX, unsigned via optional metadata

  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(185));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(16, "app", "users", sample_columns(),
                            optional_column_metadata()));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1), 16, 3,
                          {0x07}, rows));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(100));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "optional metadata parses: " +
                         (result.error ? result.error->to_string() : ""));
  const auto& change = result.transactions.at(0).changes.at(0);
  require(change.table.columns[0].name == "id", "column name id");
  require(change.table.columns[1].name == "name", "column name name");
  require(change.table.columns[2].name == "score", "column name score");
  require(change.table.columns[0].is_primary_key, "primary key metadata");
  require(change.table.columns[2].is_unsigned, "unsigned metadata");
  require(change.table.columns[0].nullable == false, "not nullable");
  require(change.table.columns[1].nullable, "name nullable");
  require(change.after.columns[2].kind == dataeng::Cell::Kind::Unsigned,
          "unsigned value kind");
  require(change.after.columns[2].as_unsigned() == 4000000000u, "unsigned value");
}

void test_bit_enum_set_values() {
  std::vector<ColumnSpec> columns = {
      {16, {0x05, 0x00}, false},  // BIT(5)
      {247, {0x01, 0x00}, false}, // ENUM pack length 1
      {248, {0x02, 0x00}, false}, // SET pack length 2
  };
  Bytes rows;
  rows.push_back(0);
  rows.push_back(0x15);  // BIT(5) = 10101
  rows.push_back(2);     // ENUM index 2
  rows.push_back(0x02);  // SET mask 0x0102, little endian
  rows.push_back(0x01);

  dataeng::BinlogAssembler assembler;
  StreamBuilder stream;
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(186));
  append_begin(stream);
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
             table_map_body(19, "app", "bits", columns));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1),
             row_event_v1(static_cast<std::uint8_t>(dataeng::EventType::WriteRowsV1), 19,
                          columns.size(), {0x07}, rows));
  stream.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(102));

  auto result = assembler.push_events(stream.data);
  require(result.ok, "bit/enum/set parse: " +
                         (result.error ? result.error->to_string() : ""));
  const auto& image = result.transactions.at(0).changes.at(0).after;
  require(image.columns[0].kind == dataeng::Cell::Kind::Bit, "bit kind");
  require(image.columns[0].as_unsigned() == 21, "bit value");
  require(image.columns[1].kind == dataeng::Cell::Kind::Enum, "enum kind");
  require(image.columns[1].as_unsigned() == 2, "enum index");
  require(image.columns[2].kind == dataeng::Cell::Kind::Set, "set kind");
  require(image.columns[2].as_unsigned() == 0x0102, "set mask");
}

struct ZstdApi {
  void* handle = nullptr;
  std::size_t (*compress_bound)(std::size_t) = nullptr;
  std::size_t (*compress)(void*, std::size_t, const void*, std::size_t, int) = nullptr;
  unsigned (*is_error)(std::size_t) = nullptr;
};

const ZstdApi* load_zstd_for_test() {
  static ZstdApi api;
  static bool loaded = false;
  if (loaded) return api.handle ? &api : nullptr;
  loaded = true;
  api.handle = dlopen("libzstd.so.1", RTLD_LAZY | RTLD_LOCAL);
  if (!api.handle) return nullptr;
  api.compress_bound = reinterpret_cast<std::size_t (*)(std::size_t)>(
      dlsym(api.handle, "ZSTD_compressBound"));
  api.compress = reinterpret_cast<std::size_t (*)(void*, std::size_t, const void*, std::size_t,
                                                  int)>(dlsym(api.handle, "ZSTD_compress"));
  api.is_error = reinterpret_cast<unsigned (*)(std::size_t)>(
      dlsym(api.handle, "ZSTD_isError"));
  if (!api.compress_bound || !api.compress || !api.is_error) return nullptr;
  return &api;
}

void test_transaction_payload_zstd() {
  const ZstdApi* zstd = load_zstd_for_test();
  if (!zstd) {
    std::cout << "  (skipping ZSTD payload test: libzstd unavailable)\n";
    return;
  }
  StreamBuilder inner;
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::TableMap),
            table_map_body(14, "app", "zstd", sample_columns()));
  append_write(inner, 14, {0x07}, rows_full_insert());
  inner.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(98));

  const std::size_t bound = zstd->compress_bound(inner.data.size());
  Bytes compressed(bound);
  const std::size_t size =
      zstd->compress(compressed.data(), compressed.size(), inner.data.data(),
                     inner.data.size(), 1);
  require(!zstd->is_error(size), "zstd compress");
  compressed.resize(size);

  Bytes body;
  put_lenenc(body, compressed.size());
  body.push_back(0);  // ZSTD
  put_lenenc(body, inner.data.size());
  body.insert(body.end(), compressed.begin(), compressed.end());

  dataeng::BinlogAssembler assembler;
  StreamBuilder outer;
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Gtid), gtid_body(190));
  append_begin(outer);
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::TransactionPayload), body);
  outer.add(static_cast<std::uint8_t>(dataeng::EventType::Xid), xid_body(99));

  auto result = assembler.push_events(outer.data);
  require(result.ok, "zstd transaction payload parses: " +
                         (result.error ? result.error->to_string() : ""));
  require(result.transactions.size() == 1, "zstd payload transaction");
  require(result.transactions.at(0).from_transaction_payload,
          "transaction marked as payload");
  require(result.transactions.at(0).changes.at(0).table.table == "zstd", "zstd row");
  require(result.transactions.at(0).xid && *result.transactions.at(0).xid == 99,
          "outer XID attached");
}

}  // namespace

int main() {
  try {
    test_full_rows_and_transaction();
    test_unknown_is_not_null();
    test_minimal_update_images();
    test_table_id_reuse_generations();
    test_table_map_lookup_by_position();
    test_checksum_failure_keeps_checkpoint_and_prior_transaction();
    test_batch_failure_delivers_preceding_transaction();
    test_missing_table_map_fails_without_advancing();
    test_rotate_clears_table_maps_but_generations_continue();
    test_rotate_event_updates_file_position();
    test_transaction_payload_none();
    test_transaction_payload_without_inner_xid();
    test_transaction_payload_failure_is_atomic();
    test_statement_transaction_and_ddl();
    test_gtid_statement_autocommit();
    test_checksum_off_fde();
    test_crc_without_fde_is_detected();
    test_v2_rows_multi_row_and_delete();
    test_v0_rows_and_full_update();
    test_decimal_and_temporal_values();
    test_optional_table_metadata_and_unsigned();
    test_bit_enum_set_values();
    test_transaction_payload_zstd();
    std::cout << "dataeng tests passed\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "test failure: " << e.what() << "\n";
    return 1;
  }
}
