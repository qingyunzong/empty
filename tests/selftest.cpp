#include "dataeng.hpp"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using dataeng::Array;
using dataeng::DataType;
using dataeng::DictionaryBatch;
using dataeng::DictionaryManager;
using dataeng::Field;
using dataeng::Message;
using dataeng::RecordBatch;
using dataeng::Schema;
using dataeng::StreamReceiver;
using dataeng::TypeId;

void Expect(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << "\n";
    std::abort();
  }
}

std::vector<std::string> Strings(const Array& array) {
  return array.ToStrings();
}

Field DictionaryField(const std::string& name, std::int64_t id,
                      const DataType& value_type = DataType::Utf8()) {
  return Field(name, value_type, id, DataType::Int32());
}

void TestReplacementKeepsQueuedIndices() {
  DictionaryManager manager;
  const std::int64_t id = 7;
  Expect(manager.RegisterField(DictionaryField("color", id)).ok(),
         "register dictionary field");
  Expect(manager.AddDictionary(id, Array::FromUtf8({"red", "green"})).ok(),
         "add base dictionary");

  RecordBatch first(Schema{DictionaryField("color", id)},
                    {Array::FromInt32({0, 1})});
  Expect(manager.AddRecordBatch(first).ok(), "enqueue first batch");

  Expect(manager.AddDictionary(id, Array::FromUtf8({"blue", "black", "white"}))
             .ok(),
         "replace dictionary");
  RecordBatch second(Schema{DictionaryField("color", id)},
                     {Array::FromInt32({2})});
  Expect(manager.AddRecordBatch(second).ok(), "enqueue second batch");

  Expect(manager.batch_count() == 2, "two batches queued");
  Expect(Strings(manager.at(0).column(0)) ==
             std::vector<std::string>({"red", "green"}),
         "old batch keeps old dictionary meaning");
  Expect(Strings(manager.at(1).column(0)) ==
             std::vector<std::string>({"white"}),
         "new batch uses replacement dictionary");
  Expect(Strings(manager.at(0).Decoded().column(0)) ==
             std::vector<std::string>({"red", "green"}),
         "materializing old batch is stable");

  Expect(manager.GenerationCount(id) == 2, "two generations");
  Expect(manager.GetGeneration(id, 1) != nullptr, "generation 1 retained");
  Expect(manager.GetGeneration(id, 2) != nullptr, "generation 2 retained");
  Expect(Strings(manager.GetGeneration(id, 1)->array()) ==
             std::vector<std::string>({"red", "green"}),
         "generation 1 values immutable");

  RecordBatch prebuilt(
      Schema{DictionaryField("color", id)},
      {Array::FromIndices({1}, manager.Current(id))});
  Expect(manager.AddRecordBatch(prebuilt).ok(),
         "prebuilt dictionary array accepted");
  Expect(Strings(manager.at(2).column(0)) ==
             std::vector<std::string>({"black"}),
         "prebuilt dictionary array resolved");
}

void TestDeltaAppendAndBounds() {
  DictionaryManager manager;
  const std::int64_t id = 3;
  Expect(manager.RegisterField(DictionaryField("word", id)).ok(),
         "register field");

  Expect(!manager.AddDelta(id, Array::FromUtf8({"orphan"})).ok(),
         "delta without base is rejected");
  Expect(manager.AddDictionary(id, Array::FromUtf8({"a", "b"})).ok(),
         "base");
  Expect(manager.AddDelta(id, Array::FromUtf8({"c", "d"})).ok(), "delta");
  Expect(manager.AddDelta(id, 4, Array::FromUtf8({"e"})).ok(),
         "delta at current end");
  Expect(!manager.AddDelta(id, 3, Array::FromUtf8({"x"})).ok(),
         "delta before current end is rejected");
  Expect(!manager.AddDelta(id, 99, Array::FromUtf8({"x"})).ok(),
         "delta beyond current end is rejected");
  Expect(!manager.AddDelta(id, Array::FromInt32({9})).ok(),
         "delta type mismatch is rejected");

  Expect(manager.Current(id)->size() == 5, "dictionary size after deltas");
  RecordBatch batch(Schema{DictionaryField("word", id)},
                    {Array::FromInt32({0, 2, 4})});
  Expect(manager.AddRecordBatch(batch).ok(), "batch using delta values");
  Expect(Strings(manager.at(0).column(0)) ==
             std::vector<std::string>({"a", "c", "e"}),
         "delta values resolve");

  RecordBatch bad(Schema{DictionaryField("word", id)},
                  {Array::FromInt32({5})});
  dataeng::BatchResult rejected = manager.AddRecordBatch(bad);
  Expect(!rejected.ok(), "out-of-range dictionary index rejected");
  Expect(rejected.status().code == dataeng::StatusCode::OutOfRange,
         "out-of-range status");
  Expect(manager.batch_count() == 1, "rejected batch not queued");
}

void TestSharedIdTypes() {
  DictionaryManager manager;
  Expect(manager.RegisterField(DictionaryField("left", 11)).ok(),
         "first field");
  Expect(manager.RegisterField(DictionaryField("right", 11)).ok(),
         "second field with same type");
  Expect(!manager.RegisterField(
              Field("wrong", DataType::Int32(), 11, DataType::Int32()))
              .ok(),
         "different value type for shared id rejected");

  DictionaryManager second;
  Schema bad;
  bad.AddField(DictionaryField("a", 5));
  bad.AddField(Field("b", DataType::Int64(), 5, DataType::Int32()));
  Expect(!second.RegisterSchema(bad).ok(), "schema-wide type conflict rejected");
  Expect(second.GenerationCount(5) == 0, "failed schema registration is atomic");

  Expect(manager.AddDictionary(11, Array::FromUtf8({"x"})).ok(),
         "dictionary type matches shared fields");
  Expect(!manager.AddDictionary(11, Array::FromInt32({1})).ok(),
         "dictionary type mismatch rejected");

  DictionaryManager empty_first;
  Expect(empty_first.AddDictionary(12, Array()).ok(),
         "empty dictionary before schema");
  Expect(empty_first.RegisterField(DictionaryField("late", 12)).ok(),
         "late field for empty dictionary");
  Expect(empty_first.AddRecordBatch(RecordBatch(
             Schema{DictionaryField("late", 12)},
             {Array::FromInt32({})}))
             .ok(),
         "empty dictionary accepts zero-length index array");

  DictionaryManager dictionary_first;
  Expect(dictionary_first.AddDictionary(
             13, Array::FromUtf8({"only"}))
             .ok(),
         "dictionary before field registration");
  Expect(dictionary_first.RegisterField(
             Field("narrow", DataType::Utf8(), 13, DataType::UInt8()))
             .ok(),
         "field supplies index type after dictionary");
  Expect(dictionary_first.AddRecordBatch(RecordBatch(
             Schema{Field("narrow", DataType::Utf8(), 13,
                          DataType::UInt8())},
             {Array::FromUInt8({0})}))
             .ok(),
         "batch with narrow index type");
  Expect(dictionary_first.at(0).column(0).index_type() ==
             DataType::UInt8(),
         "column keeps field index type");
}

std::vector<Message> BuildMessages(std::int64_t id) {
  const Schema schema{DictionaryField("word", id)};
  std::vector<Message> messages;
  messages.push_back(Message::SchemaMessage(schema));
  messages.push_back(
      Message::Dictionary(id, Array::FromUtf8({"alpha", "beta", "gamma"})));
  messages.push_back(Message::Batch(
      RecordBatch(schema, {Array::FromInt32({0, 1})})));
  messages.push_back(Message::Dictionary(
      id, Array::FromUtf8({"delta"}), true));
  messages.push_back(Message::Batch(
      RecordBatch(schema, {Array::FromInt32({2, 3})})));
  messages.push_back(Message::EndOfStream());
  return messages;
}

void TestChunkedStreamEqualsWholeStream() {
  const std::vector<Message> messages = BuildMessages(42);
  dataeng::Status encode_status;
  const std::vector<std::uint8_t> stream =
      dataeng::EncodeMessages(messages, &encode_status);
  Expect(encode_status.ok(), "encode complete stream");

  StreamReceiver whole;
  Expect(whole.Feed(stream).ok(), "feed complete stream");
  Expect(whole.Finish().ok(), "finish complete stream");

  static const std::size_t chunk_pattern[] = {
      1, 3, 2, 7, 5, 11, 4, 13, 1, 17, 2, 19, 3, 23, 5, 29};
  for (std::size_t pattern_index = 0; pattern_index < 3; ++pattern_index) {
    StreamReceiver chunked;
    std::size_t offset = 0;
    std::size_t chunk_index = pattern_index * 5;
    while (offset < stream.size()) {
      const std::size_t chunk =
          std::min<std::size_t>(chunk_pattern[chunk_index % 16],
                                stream.size() - offset);
      dataeng::BatchList result =
          chunked.Feed(stream.data() + offset, chunk);
      Expect(result.ok(), "chunked feed");
      offset += chunk;
      ++chunk_index;
    }
    dataeng::BatchList finish = chunked.Finish();
    Expect(finish.ok(), "chunked finish");

    Expect(chunked.batches().size() == whole.batches().size(),
           "same number of batches");
    for (std::size_t i = 0; i < chunked.batches().size(); ++i) {
      Expect(chunked.batches()[i] == whole.batches()[i],
             "chunked batch equals whole batch");
      Expect(Strings(chunked.batches()[i].Decoded().column(0)) ==
                 Strings(whole.batches()[i].Decoded().column(0)),
             "chunked decoded array equals whole decoded array");
    }
    Expect(Strings(chunked.batches()[0].column(0)) ==
               std::vector<std::string>({"alpha", "beta"}),
           "pre-delta batch keeps snapshot");
    Expect(Strings(chunked.batches()[1].column(0)) ==
               std::vector<std::string>({"gamma", "delta"}),
           "post-delta batch sees appended values");
  }
}

void TestCodecRoundTrip() {
  Array nullable = Array::FromOptional<std::string>(
      {std::string("a"), std::nullopt, std::string("c")});
  Array floating = Array::FromFloat64({1.25, -2.5, 3.75});

  const std::vector<Message> messages = {
      Message::Batch(RecordBatch(
          Schema{Field("s", DataType::Utf8()), Field("d", DataType::Float64())},
          {nullable, floating})),
  };
  dataeng::Status status;
  const std::vector<std::uint8_t> bytes =
      dataeng::EncodeMessages(messages, &status);
  Expect(status.ok(), "encode round trip");
  std::vector<Message> decoded;
  Expect(dataeng::DecodeMessages(bytes, &decoded).ok(), "decode round trip");
  Expect(decoded.size() == 1, "one decoded message");
  Expect(decoded[0].record_batch.columns.size() == 2, "two decoded columns");
  Expect(decoded[0].record_batch.columns[0] == nullable,
         "nullable string array round trip");
  Expect(decoded[0].record_batch.columns[1] == floating,
         "floating array round trip");

  DictionaryManager manager;
  const std::int64_t id = 71;
  manager.RegisterField(DictionaryField("word", id));
  manager.AddDictionary(id, Array::FromUtf8({"one", "two"}));
  manager.AddRecordBatch(RecordBatch(
      Schema{DictionaryField("word", id)}, {Array::FromInt32({1, 0})}));
  const std::vector<std::uint8_t> dictionary_bytes =
      dataeng::EncodeMessage(Message::Batch(manager.at(0)));
  std::vector<Message> dictionary_messages;
  Expect(dataeng::DecodeMessages(dictionary_bytes, &dictionary_messages).ok(),
         "dictionary array message round trip");
  Expect(dictionary_messages.size() == 1, "one dictionary array message");
  Expect(Strings(dictionary_messages[0].record_batch.column(0)) ==
             std::vector<std::string>({"two", "one"}),
         "dictionary array snapshot round trip");
}

void TestReceiverRecoversFromRejectedMessage() {
  StreamReceiver receiver;
  const Schema schema{DictionaryField("word", 90)};
  Expect(receiver.Push(Message::SchemaMessage(schema)).ok(), "schema");
  Expect(receiver.Push(Message::Dictionary(90, Array::FromUtf8({"x"}))).ok(),
         "dictionary");
  dataeng::BatchList bad = receiver.Push(Message::Batch(
      RecordBatch(schema, {Array::FromInt32({4})})));
  Expect(!bad.ok(), "invalid index rejected");
  dataeng::BatchList good = receiver.Push(Message::Batch(
      RecordBatch(schema, {Array::FromInt32({0})})));
  Expect(good.ok(), "receiver can continue after semantic rejection");
  Expect(receiver.size() == 1, "only valid batch queued");
}

std::vector<std::uint8_t> HexToBytes(const std::vector<std::string>& lines) {
  std::vector<std::uint8_t> bytes;
  for (const std::string& line : lines) {
    for (std::size_t i = 0; i + 1 < line.size(); i += 2) {
      const int hi = std::stoi(line.substr(i, 1), nullptr, 16);
      const int lo = std::stoi(line.substr(i + 1, 1), nullptr, 16);
      bytes.push_back(static_cast<std::uint8_t>((hi << 4) | lo));
    }
  }
  return bytes;
}

void TestArrowIpcStream() {
  const std::vector<std::uint8_t> stream = HexToBytes({
      "ffffffffc8000000100000000c00180004000600080010000c000000010001001c000000000000000000000000000000",
      "0c001400040008000c0010000c000000000000000c000000000000000000000001000000140000001000180004000800",
      "09000c00100014001000000014000000010500001b000000270000004c00000004000000776f72640006000400000006",
      "0000000c00180008001000140016000c0000000000000007000000000000001000000000000000080009000400080008",
      "00000020000000010000000000000000ffffffffb8000000100000000c00180004000600080010000c00000001000200",
      "1a000000000000001e000000000000000a0015000800100014000a00000000000000070000000000000011000000000c",
      "001c0008001000140018000c0000000000000003000000000000000c0000001c00000000000000010000000300000000",
      "000000000000000000000003000000000000000000000000000000000000000000000000000000100000000000000010",
      "000000000000000e00000000000000000000000005000000090000000e000000616c7068616265746167616d6d610000",
      "ffffffff88000000100000000c00180004000600080010000c000000010003001c000000000000000800000000000000",
      "0c001c0008001000140018000c0000000000000002000000000000000c0000001c000000000000000100000002000000",
      "000000000000000000000000020000000000000000000000000000000000000000000000000000000800000000000000",
      "0000000001000000ffffffffb8000000100000000c00180004000600080010000c000000010002001a00000000000000",
      "0d000000000000000a0015000800100014000a00000000000000070000000000000011000000010c001c000800100014",
      "0018000c0000000000000001000000000000000c0000001c000000000000000100000001000000000000000000000000",
      "000000030000000000000000000000000000000000000000000000000000000800000000000000080000000000000005",
      "0000000000000000000000000500000064656c7461000000ffffffff88000000100000000c0018000400060008001000",
      "0c000000010003001c0000000000000008000000000000000c001c0008001000140018000c0000000000000002000000",
      "000000000c0000001c000000000000000100000002000000000000000000000000000000020000000000000000000000",
      "0000000000000000000000000000000008000000000000000200000003000000ffffffff00000000",
  });

  StreamReceiver whole;
  Expect(whole.Feed(stream).ok(), "whole Arrow stream");
  Expect(whole.Finish().ok(), "finish Arrow stream");
  Expect(whole.size() == 2, "Arrow stream batches");
  Expect(Strings(whole.batches()[0].column(0)) ==
             std::vector<std::string>({"alpha", "beta"}),
         "Arrow dictionary batch decoded");
  Expect(Strings(whole.batches()[1].column(0)) ==
             std::vector<std::string>({"gamma", "delta"}),
         "Arrow dictionary delta decoded");

  StreamReceiver chunked;
  std::size_t offset = 0;
  std::size_t chunk_index = 0;
  static const std::size_t sizes[] = {1, 2, 3, 5, 7, 11, 13, 17};
  while (offset < stream.size()) {
    const std::size_t chunk =
        std::min<std::size_t>(sizes[chunk_index % 8], stream.size() - offset);
    Expect(chunked.Feed(stream.data() + offset, chunk).ok(),
           "chunked Arrow feed");
    offset += chunk;
    ++chunk_index;
  }
  Expect(chunked.Finish().ok(), "finish chunked Arrow stream");
  Expect(chunked.size() == whole.size(), "Arrow chunk count");
  for (std::size_t i = 0; i < whole.size(); ++i) {
    Expect(chunked.batches()[i] == whole.batches()[i],
           "Arrow chunked batch equality");
  }
}

}  // namespace

int main() {
  TestReplacementKeepsQueuedIndices();
  TestDeltaAppendAndBounds();
  TestSharedIdTypes();
  TestChunkedStreamEqualsWholeStream();
  TestCodecRoundTrip();
  TestReceiverRecoversFromRejectedMessage();
  TestArrowIpcStream();
  std::cout << "dataeng tests passed\n";
  return 0;
}
