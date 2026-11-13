#include "dataeng.hpp"

#include <algorithm>
#include <limits>
#include <set>
#include <sstream>
#include <utility>

namespace dataeng {

namespace {

constexpr std::size_t kUnknownPosition = std::numeric_limits<std::size_t>::max();

std::string join_path(const std::vector<std::string>& path) {
  std::ostringstream out;
  for (std::size_t i = 0; i < path.size(); ++i) {
    if (i != 0) {
      out << '.';
    }
    out << (path[i].empty() ? "<anonymous>" : path[i]);
  }
  return out.str();
}

struct Step {
  const SchemaNode* node = nullptr;
  int parent_definition = 0;
  int parent_repetition = 0;
  int definition = 0;
  int list_repetition = -1;
};

struct LeafPlan {
  LeafInfo info;
  std::vector<Step> steps;
  std::vector<std::string> alias_path;
};

void validate_schema_node(const SchemaNode& node, bool is_root) {
  if (node.name.empty() && !is_root) {
    throw std::invalid_argument("schema node names must not be empty");
  }
  switch (node.kind) {
    case SchemaKind::Primitive:
      if (!node.children.empty()) {
        throw std::invalid_argument("primitive schema node '" + node.name +
                                    "' must not have children");
      }
      break;
    case SchemaKind::Struct:
      if (!is_root && node.children.empty()) {
        throw std::invalid_argument("struct '" + node.name +
                                    "' must contain at least one field");
      }
      {
        std::set<std::string> field_names;
        for (const SchemaNode& child : node.children) {
          if (!field_names.insert(child.name).second) {
            throw std::invalid_argument("duplicate field '" + child.name +
                                        "' in struct '" + node.name + "'");
          }
        }
      }
      for (const SchemaNode& child : node.children) {
        validate_schema_node(child, false);
      }
      break;
    case SchemaKind::List:
      if (node.children.size() != 1) {
        throw std::invalid_argument("list schema node '" + node.name +
                                    "' must have exactly one element");
      }
      validate_schema_node(node.children.front(), false);
      break;
  }
}

void add_plan(const SchemaNode& node, std::vector<std::string>& canonical,
              std::vector<std::string>& alias, bool skip_alias,
              int parent_definition, int parent_repetition,
              std::vector<Step>& steps, std::vector<LeafPlan>& plans) {
  const int definition =
      parent_definition + (node.presence == Presence::Optional ? 1 : 0);

  Step step;
  step.node = &node;
  step.parent_definition = parent_definition;
  step.parent_repetition = parent_repetition;
  step.definition = definition;
  if (node.kind == SchemaKind::List) {
    step.list_repetition = parent_repetition + 1;
  }
  steps.push_back(step);

  canonical.push_back(node.name);
  if (!skip_alias) {
    alias.push_back(node.name);
  }

  if (node.kind == SchemaKind::Primitive) {
    LeafPlan plan;
    plan.info.path = canonical;
    plan.info.max_definition_level = definition;
    plan.info.max_repetition_level = parent_repetition;
    plan.steps = steps;
    plan.alias_path = alias;
    plans.push_back(std::move(plan));
  } else if (node.kind == SchemaKind::Struct) {
    for (const SchemaNode& child : node.children) {
      add_plan(child, canonical, alias, false, definition,
               parent_repetition, steps, plans);
    }
  } else {
    const SchemaNode& element = node.children.front();
    // The repeated element is a physical layer of the Parquet LIST encoding.
    // Keep it in the canonical path, but allow callers to omit it in the
    // friendlier logical path.
    add_plan(element, canonical, alias, true, definition + 1,
             parent_repetition + 1, steps, plans);
  }

  if (!skip_alias) {
    alias.pop_back();
  }
  canonical.pop_back();
  steps.pop_back();
}

std::vector<LeafPlan> build_plans(const SchemaNode& schema) {
  if (schema.kind != SchemaKind::Struct) {
    throw std::invalid_argument("the schema root must be a struct");
  }
  validate_schema_node(schema, true);

  std::vector<LeafPlan> plans;
  std::vector<std::string> canonical;
  std::vector<std::string> alias;
  std::vector<Step> steps;
  for (const SchemaNode& child : schema.children) {
    add_plan(child, canonical, alias, false, 0, 0, steps, plans);
  }
  if (plans.empty()) {
    throw std::invalid_argument("the schema must contain at least one leaf");
  }
  return plans;
}

std::vector<std::string> normalize_path(const SchemaNode& schema,
                                        std::vector<std::string> path) {
  if (!path.empty() && path.front() == schema.name) {
    path.erase(path.begin());
  }
  return path;
}

const SchemaNode* find_field(const SchemaNode& node,
                             const std::string& name) {
  for (const SchemaNode& child : node.children) {
    if (child.name == name) {
      return &child;
    }
  }
  return nullptr;
}

std::string effective_label(const Column& column) {
  if (!column.label.empty()) {
    return column.label;
  }
  return join_path(column.path);
}

[[noreturn]] void throw_ambiguous(const Column& column,
                                  const std::vector<std::string>& path) {
  throw DecodeError("column path '" + join_path(path) +
                        "' matches more than one schema leaf",
                    kUnknownPosition, effective_label(column));
}

std::size_t resolve_plan(const SchemaNode& schema,
                         const std::vector<LeafPlan>& plans,
                         const Column& column) {
  std::vector<std::string> path = normalize_path(schema, column.path);
  if (path.empty()) {
    if (plans.size() == 1) {
      return 0;
    }
    throw DecodeError("an empty column path is ambiguous for a schema with " +
                          std::to_string(plans.size()) + " leaves",
                      kUnknownPosition, effective_label(column));
  }

  auto unique = [&](auto predicate) -> std::optional<std::size_t> {
    std::optional<std::size_t> found;
    for (std::size_t i = 0; i < plans.size(); ++i) {
      if (!predicate(plans[i])) {
        continue;
      }
      if (found) {
        throw_ambiguous(column, column.path);
      }
      found = i;
    }
    return found;
  };

  if (auto found = unique([&](const LeafPlan& plan) {
        return plan.info.path == path;
      })) {
    return *found;
  }
  if (auto found = unique([&](const LeafPlan& plan) {
        return plan.alias_path == path;
      })) {
    return *found;
  }

  // A prefix is accepted when it identifies exactly one leaf.  This supports
  // selecting a list field by its logical name without spelling the synthetic
  // element layer.
  if (auto found = unique([&](const LeafPlan& plan) {
        auto starts_with = [&](const std::vector<std::string>& candidate) {
          return candidate.size() >= path.size() &&
                 std::equal(path.begin(), path.end(), candidate.begin());
        };
        return starts_with(plan.info.path) || starts_with(plan.alias_path);
      })) {
    return *found;
  }

  // A bare leaf name is also convenient for flat schemas.
  if (path.size() == 1) {
    if (auto found = unique([&](const LeafPlan& plan) {
          return plan.info.path.back() == path.front();
        })) {
      return *found;
    }
  }

  throw DecodeError("column path '" + join_path(path) +
                        "' does not identify a schema leaf",
                    kUnknownPosition, effective_label(column));
}

void validate_levels(const Column& column, const LeafInfo& info) {
  if (column.repetition_levels.size() !=
      column.definition_levels.size()) {
    throw DecodeError(
        "repetition and definition streams have different lengths (" +
            std::to_string(column.repetition_levels.size()) + " vs " +
            std::to_string(column.definition_levels.size()) + ")",
        std::min(column.repetition_levels.size(),
                 column.definition_levels.size()),
        effective_label(column));
  }

  const auto& repetitions = column.repetition_levels;
  const auto& definitions = column.definition_levels;

  std::size_t row_index = 0;
  for (std::size_t i = 0; i < repetitions.size(); ++i) {
    const int repetition = repetitions[i];
    const int definition = definitions[i];
    if (i != 0 && repetition == 0) {
      ++row_index;
    }

    if (repetition < 0 || repetition > info.max_repetition_level) {
      throw DecodeError("repetition level " + std::to_string(repetition) +
                            " is outside [0, " +
                            std::to_string(info.max_repetition_level) + "]",
                        i, effective_label(column), row_index);
    }
    if (definition < 0 || definition > info.max_definition_level) {
      throw DecodeError("definition level " + std::to_string(definition) +
                            " is outside [0, " +
                            std::to_string(info.max_definition_level) + "]",
                        i, effective_label(column), row_index);
    }
    if (repetition > definition) {
      throw DecodeError(
          "repetition level " + std::to_string(repetition) +
              " exceeds definition level " + std::to_string(definition),
          i, effective_label(column), row_index);
    }
    if (i == 0 && repetition != 0) {
      throw DecodeError("the first event must start a record (repetition 0)",
                        i, effective_label(column), row_index);
    }
  }

  // Validate the value stream length before decoding.  In particular, if an
  // event requires a value but the stream is exhausted, report that event's
  // position instead of indexing past the end of the value vector.
  std::size_t required_values = 0;
  std::optional<std::size_t> first_required;
  for (std::size_t i = 0; i < definitions.size(); ++i) {
    if (definitions[i] == info.max_definition_level) {
      if (!first_required) {
        first_required = i;
      }
      ++required_values;
    }
  }
  if (required_values > column.values.size()) {
    std::size_t seen = 0;
    row_index = 0;
    for (std::size_t i = 0; i < definitions.size(); ++i) {
      if (i != 0 && repetitions[i] == 0) {
        ++row_index;
      }
      if (definitions[i] != info.max_definition_level) {
        continue;
      }
      if (seen == column.values.size()) {
        throw DecodeError(
            "value stream is exhausted before the event at this position",
            i, effective_label(column), row_index);
      }
      ++seen;
    }
  }
  if (required_values < column.values.size()) {
    const std::size_t position =
        first_required ? *first_required : definitions.size();
    throw DecodeError(
        "value stream contains " +
            std::to_string(column.values.size() - required_values) +
            " value(s) not selected by the definition levels",
        position, effective_label(column));
  }
}

struct RowSpan {
  std::size_t begin = 0;
  std::size_t end = 0;
};

std::vector<RowSpan> split_rows(const Column& column) {
  std::vector<RowSpan> rows;
  const auto& repetitions = column.repetition_levels;
  if (repetitions.empty()) {
    return rows;
  }
  std::size_t begin = 0;
  for (std::size_t i = 1; i < repetitions.size(); ++i) {
    if (repetitions[i] == 0) {
      rows.push_back({begin, i});
      begin = i;
    }
  }
  rows.push_back({begin, repetitions.size()});
  return rows;
}

enum class PrimitiveFamily { Boolean, Signed, Unsigned, Floating, Text };

PrimitiveFamily family_of(PrimitiveType type) {
  switch (type) {
    case PrimitiveType::Boolean:
      return PrimitiveFamily::Boolean;
    case PrimitiveType::Int32:
    case PrimitiveType::Int64:
      return PrimitiveFamily::Signed;
    case PrimitiveType::UInt64:
      return PrimitiveFamily::Unsigned;
    case PrimitiveType::Float:
    case PrimitiveType::Double:
      return PrimitiveFamily::Floating;
    case PrimitiveType::String:
    case PrimitiveType::Binary:
      return PrimitiveFamily::Text;
  }
  return PrimitiveFamily::Text;
}

bool value_matches_type(const Value& value, PrimitiveType type) {
  const bool signed_value = std::holds_alternative<std::int32_t>(value.data) ||
                            std::holds_alternative<std::int64_t>(value.data);
  const bool unsigned_value =
      std::holds_alternative<std::uint64_t>(value.data);
  const bool integer_value = signed_value || unsigned_value;
  const bool floating_value = std::holds_alternative<float>(value.data) ||
                              std::holds_alternative<double>(value.data);
  switch (family_of(type)) {
    case PrimitiveFamily::Boolean:
      return std::holds_alternative<bool>(value.data);
    case PrimitiveFamily::Signed:
      return integer_value;
    case PrimitiveFamily::Unsigned:
      return integer_value;
    case PrimitiveFamily::Floating:
      return floating_value || integer_value;
    case PrimitiveFamily::Text:
      return std::holds_alternative<std::string>(value.data);
  }
  return false;
}

Value decode_step(const LeafPlan& plan, std::size_t step_index,
                  const Column& column, std::size_t& event_index,
                  std::size_t& value_index, std::size_t row_index,
                  std::size_t row_end) {
  const Step& step = plan.steps[step_index];
  const SchemaNode& node = *step.node;
  const int definition = column.definition_levels[event_index];

  if (node.presence == Presence::Optional && definition < step.definition) {
    ++event_index;
    return Value::null();
  }
  if (node.presence == Presence::Required && definition < step.definition) {
    // An ancestor is absent.  Normally the ancestor consumes this event; this
    // guard keeps malformed streams from reading a value that is not present.
    ++event_index;
    return Value::null();
  }

  switch (node.kind) {
    case SchemaKind::Primitive: {
      if (definition < step.definition) {
        ++event_index;
        return Value::null();
      }
      if (value_index >= column.values.size()) {
        throw DecodeError(
            "value stream is exhausted before consuming this event",
            event_index, effective_label(column), row_index);
      }
      if (!value_matches_type(column.values[value_index],
                              node.primitive_type)) {
        throw DecodeError("value type does not match primitive schema type",
                          event_index, effective_label(column), row_index);
      }
      Value value = column.values[value_index++];
      ++event_index;
      return value;
    }

    case SchemaKind::Struct: {
      Value object = Value::object();
      if (step_index + 1 >= plan.steps.size()) {
        throw DecodeError("struct has no leaf descendant", event_index,
                          effective_label(column), row_index);
      }
      const SchemaNode& child = *plan.steps[step_index + 1].node;
      Value child_value =
          decode_step(plan, step_index + 1, column, event_index, value_index,
                      row_index, row_end);
      object.as_object().emplace(child.name, std::move(child_value));
      return object;
    }

    case SchemaKind::List: {
      if (definition == step.definition) {
        ++event_index;
        return Value::list();
      }

      if (step_index + 1 >= plan.steps.size()) {
        throw DecodeError("list has no element leaf", event_index,
                          effective_label(column), row_index);
      }

      Value::Array elements;
      const int list_repetition = step.list_repetition;
      while (true) {
        if (event_index >= row_end) {
          throw DecodeError("record ended in the middle of a list",
                            event_index, effective_label(column), row_index);
        }
        elements.push_back(decode_step(plan, step_index + 1, column,
                                       event_index, value_index, row_index,
                                       row_end));
        if (event_index >= row_end) {
          break;
        }
        const int next_repetition =
            column.repetition_levels[event_index];
        if (next_repetition == list_repetition) {
          continue;
        }
        if (next_repetition > list_repetition) {
          throw DecodeError(
              "repetition level " + std::to_string(next_repetition) +
                  " cannot continue the current list at level " +
                  std::to_string(list_repetition),
              event_index, effective_label(column), row_index);
        }
        break;
      }
      return Value::list(std::move(elements));
    }
  }

  throw DecodeError("unreachable schema kind", event_index,
                    effective_label(column), row_index);
}

Value make_partial_record(const LeafPlan& plan, const Column& column,
                          const RowSpan& row, std::size_t row_index) {
  std::size_t event_index = row.begin;
  std::size_t value_index = 0;
  for (std::size_t i = 0; i < row.begin; ++i) {
    if (column.definition_levels[i] == plan.info.max_definition_level) {
      ++value_index;
    }
  }

  Value root = Value::object();
  Value child = decode_step(plan, 0, column, event_index, value_index,
                            row_index, row.end);
  root.as_object().emplace(plan.steps.front().node->name, std::move(child));
  if (event_index != row.end) {
    throw DecodeError(
        "level sequence leaves " +
            std::to_string(row.end - event_index) +
            " unconsumed event(s); repetition levels do not describe a valid "
            "record",
        event_index, effective_label(column), row_index);
  }
  return root;
}

[[noreturn]] void throw_merge_error(const std::string& message,
                                    std::size_t row_index,
                                    const std::string& column) {
  throw DecodeError(message, kUnknownPosition, column, row_index);
}

Value merge_values(const Value& left, const Value& right,
                   const SchemaNode& node, std::size_t row_index,
                   const std::string& column) {
  if (left.is_null() || right.is_null()) {
    if (left.is_null() && right.is_null()) {
      return Value::null();
    }
    throw_merge_error("columns disagree about whether '" + node.name +
                          "' is null or present",
                      row_index, column);
  }

  switch (node.kind) {
    case SchemaKind::Primitive:
      if (left != right) {
        throw_merge_error("columns disagree about the value of '" + node.name +
                              "'",
                          row_index, column);
      }
      return left;

    case SchemaKind::Struct: {
      if (!left.is_object() || !right.is_object()) {
        throw_merge_error("columns disagree about struct '" + node.name + "'",
                          row_index, column);
      }
      Value merged(left);
      for (const auto& [name, value] : right.as_object()) {
        auto existing = merged.as_object().find(name);
        if (existing == merged.as_object().end()) {
          merged.as_object().emplace(name, value);
          continue;
        }
        const SchemaNode* field = find_field(node, name);
        if (field == nullptr) {
          throw_merge_error("unknown field '" + name + "' while merging '" +
                                node.name + "'",
                            row_index, column);
        }
        existing->second =
            merge_values(existing->second, value, *field, row_index, column);
      }
      return merged;
    }

    case SchemaKind::List: {
      if (!left.is_array() || !right.is_array()) {
        throw_merge_error("columns disagree about list '" + node.name + "'",
                          row_index, column);
      }
      if (left.as_array().size() != right.as_array().size()) {
        throw_merge_error(
            "columns decoded different element counts for list '" + node.name +
                "' (" + std::to_string(left.as_array().size()) + " vs " +
                std::to_string(right.as_array().size()) + ")",
            row_index, column);
      }
      Value merged = left;
      const SchemaNode& element = node.children.front();
      for (std::size_t i = 0; i < right.as_array().size(); ++i) {
        merged.as_array()[i] =
            merge_values(merged.as_array()[i], right.as_array()[i], element,
                         row_index, column);
      }
      return merged;
    }
  }

  throw_merge_error("unreachable schema kind while merging", row_index,
                    column);
}

struct EncodedEvent {
  int repetition = 0;
  int definition = 0;
  std::optional<Value> value;
};

void encode_step(const LeafPlan& plan, std::size_t step_index,
                 const Value& value, int parent_definition, int repetition,
                 std::size_t row_index, std::vector<EncodedEvent>& events) {
  const Step& step = plan.steps[step_index];
  const SchemaNode& node = *step.node;

  if (value.is_null()) {
    if (node.presence == Presence::Required) {
      throw EncodeError("required node '" + node.name + "' is null", row_index,
                        join_path(plan.info.path), row_index);
    }
    events.push_back({repetition, parent_definition, std::nullopt});
    return;
  }

  switch (node.kind) {
    case SchemaKind::Primitive:
      if (!value_matches_type(value, node.primitive_type)) {
        throw EncodeError("value type does not match primitive schema type",
                          row_index, join_path(plan.info.path), row_index);
      }
      events.push_back({repetition, step.definition, value});
      return;

    case SchemaKind::Struct: {
      if (!value.is_object()) {
        throw EncodeError("struct '" + node.name + "' must be an object",
                          row_index, join_path(plan.info.path), row_index);
      }
      if (step_index + 1 >= plan.steps.size()) {
        throw EncodeError("struct has no leaf descendant", row_index,
                          join_path(plan.info.path), row_index);
      }
      const SchemaNode& child = *plan.steps[step_index + 1].node;
      auto found = value.as_object().find(child.name);
      if (found == value.as_object().end()) {
        if (child.presence == Presence::Required) {
          throw EncodeError("required field '" + child.name + "' is missing",
                            row_index, join_path(plan.info.path), row_index);
        }
        static const Value kNull;
        encode_step(plan, step_index + 1, kNull, step.definition, repetition,
                    row_index, events);
      } else {
        encode_step(plan, step_index + 1, found->second, step.definition,
                    repetition, row_index, events);
      }
      return;
    }

    case SchemaKind::List: {
      if (!value.is_array()) {
        throw EncodeError("list '" + node.name + "' must be an array",
                          row_index, join_path(plan.info.path), row_index);
      }
      if (value.as_array().empty()) {
        events.push_back({repetition, step.definition, std::nullopt});
        return;
      }
      for (std::size_t i = 0; i < value.as_array().size(); ++i) {
        const int element_repetition =
            i == 0 ? repetition : step.list_repetition;
        encode_step(plan, step_index + 1, value.as_array()[i],
                    step.definition + 1, element_repetition, row_index,
                    events);
      }
      return;
    }
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

SchemaNode::SchemaNode(std::string node_name, SchemaKind node_kind,
                       Presence node_presence, PrimitiveType type)
    : name(std::move(node_name)),
      kind(node_kind),
      presence(node_presence),
      primitive_type(type) {}

SchemaNode SchemaNode::root(std::string name,
                            std::vector<SchemaNode> fields) {
  return group(std::move(name), Presence::Required, std::move(fields));
}

SchemaNode SchemaNode::group(std::string name, Presence presence,
                             std::vector<SchemaNode> fields) {
  SchemaNode node(std::move(name), SchemaKind::Struct, presence);
  node.children = std::move(fields);
  return node;
}

SchemaNode SchemaNode::list(std::string name, Presence presence,
                            SchemaNode element) {
  SchemaNode node(std::move(name), SchemaKind::List, presence);
  node.children.push_back(std::move(element));
  return node;
}

SchemaNode SchemaNode::primitive(std::string name, PrimitiveType type,
                                 Presence presence) {
  return SchemaNode(std::move(name), SchemaKind::Primitive, presence, type);
}

SchemaNode SchemaNode::optional_group(std::string name,
                                      std::vector<SchemaNode> fields) {
  return group(std::move(name), Presence::Optional, std::move(fields));
}

SchemaNode SchemaNode::required_group(std::string name,
                                      std::vector<SchemaNode> fields) {
  return group(std::move(name), Presence::Required, std::move(fields));
}

SchemaNode SchemaNode::optional_list(std::string name, SchemaNode element) {
  return list(std::move(name), Presence::Optional, std::move(element));
}

SchemaNode SchemaNode::required_list(std::string name, SchemaNode element) {
  return list(std::move(name), Presence::Required, std::move(element));
}

SchemaNode SchemaNode::optional_primitive(std::string name,
                                          PrimitiveType type) {
  return primitive(std::move(name), type, Presence::Optional);
}

SchemaNode SchemaNode::required_primitive(std::string name,
                                          PrimitiveType type) {
  return primitive(std::move(name), type, Presence::Required);
}

// ---------------------------------------------------------------------------
// Values and columns
// ---------------------------------------------------------------------------

Column::Column(std::vector<std::string> field_path,
               std::vector<int> repetition, std::vector<int> definition,
               std::vector<Value> stream_values)
    : path(std::move(field_path)),
      repetition_levels(std::move(repetition)),
      definition_levels(std::move(definition)),
      values(std::move(stream_values)) {}

Column Column::from_path(std::string field_path, std::vector<int> repetition,
                         std::vector<int> definition,
                         std::vector<Value> stream_values) {
  Column column;
  column.repetition_levels = std::move(repetition);
  column.definition_levels = std::move(definition);
  column.values = std::move(stream_values);
  std::vector<std::string> path;
  std::string current;
  for (char character : field_path) {
    if (character == '.' || character == '/') {
      if (!current.empty()) {
        path.push_back(std::move(current));
        current.clear();
      }
    } else {
      current.push_back(character);
    }
  }
  if (!current.empty()) {
    path.push_back(std::move(current));
  }
  column.path = std::move(path);
  return column;
}

std::string Column::name() const {
  if (!label.empty()) {
    return label;
  }
  return join_path(path);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

DataEngError::DataEngError(std::string message, std::size_t position,
                           std::string column, std::optional<std::size_t> row)
    : std::runtime_error([&] {
        std::ostringstream out;
        out << message;
        if (!column.empty()) {
          out << " [column: " << column << ']';
        }
        if (position == kUnknownPosition) {
          out << " at unknown position";
        } else {
          out << " at position " << position;
        }
        if (row) {
          out << " (row " << *row << ')';
        }
        return out.str();
      }()),
      position_(position),
      column_(std::move(column)),
      row_(row) {}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

Decoder::Decoder(SchemaNode schema) : schema_(std::move(schema)) {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  leaves_.reserve(plans.size());
  for (const LeafPlan& plan : plans) {
    leaves_.push_back(plan.info);
  }
}

std::vector<Value> Decoder::decode(const std::vector<Column>& columns) const {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  if (columns.empty()) {
    return {};
  }

  struct ResolvedColumn {
    const Column* column = nullptr;
    const LeafPlan* plan = nullptr;
    std::vector<RowSpan> rows;
    std::vector<Value> partials;
  };

  std::vector<ResolvedColumn> resolved;
  resolved.reserve(columns.size());
  std::vector<bool> used(plans.size(), false);

  for (const Column& column : columns) {
    const std::size_t index = resolve_plan(schema_, plans, column);
    if (used[index]) {
      throw DecodeError("column path '" + join_path(plans[index].info.path) +
                            "' was supplied more than once",
                        kUnknownPosition, effective_label(column));
    }
    used[index] = true;
    validate_levels(column, plans[index].info);
    resolved.push_back({&column, &plans[index], split_rows(column), {}});
  }

  const std::size_t row_count = resolved.front().rows.size();
  for (const ResolvedColumn& item : resolved) {
    if (item.rows.size() != row_count) {
      std::size_t position = 0;
      if (item.rows.size() > row_count) {
        position = item.rows[row_count].begin;
      } else if (!item.rows.empty()) {
        position = item.rows.back().end;
      }
      throw DecodeError(
          "column has " + std::to_string(item.rows.size()) +
              " record(s), expected " + std::to_string(row_count),
          position, effective_label(*item.column),
          std::min(item.rows.size(), row_count));
    }
  }

  for (ResolvedColumn& item : resolved) {
    item.partials.reserve(row_count);
    for (std::size_t row = 0; row < row_count; ++row) {
      Value partial = make_partial_record(*item.plan, *item.column,
                                          item.rows[row], row);
      item.partials.push_back(std::move(partial));
    }
  }

  std::vector<Value> records(row_count, Value::object());
  for (std::size_t row = 0; row < row_count; ++row) {
    Value merged = resolved.front().partials[row];
    for (std::size_t i = 1; i < resolved.size(); ++i) {
      merged = merge_values(merged, resolved[i].partials[row], schema_, row,
                            effective_label(*resolved[i].column));
    }
    records[row] = std::move(merged);
  }
  return records;
}

int Decoder::max_definition_level(
    const std::vector<std::string>& path) const {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  Column probe;
  probe.path = path;
  return plans[resolve_plan(schema_, plans, probe)]
      .info.max_definition_level;
}

int Decoder::max_repetition_level(
    const std::vector<std::string>& path) const {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  Column probe;
  probe.path = path;
  return plans[resolve_plan(schema_, plans, probe)]
      .info.max_repetition_level;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

Encoder::Encoder(SchemaNode schema) : schema_(std::move(schema)) {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  leaves_.reserve(plans.size());
  for (const LeafPlan& plan : plans) {
    leaves_.push_back(plan.info);
  }
}

std::vector<Column> Encoder::encode(const std::vector<Value>& rows) const {
  const std::vector<LeafPlan> plans = build_plans(schema_);
  std::vector<Column> columns;
  columns.reserve(plans.size());

  for (const LeafPlan& plan : plans) {
    Column column;
    column.path = plan.info.path;
    column.label = join_path(plan.info.path);

    for (std::size_t row = 0; row < rows.size(); ++row) {
      const Value& record = rows[row];
      if (!record.is_object()) {
        throw EncodeError("record must be a struct object", row,
                          column.label, row);
      }
      const SchemaNode& first = *plan.steps.front().node;
      auto found = record.as_object().find(first.name);
      static const Value kNull;
      const Value& field = found == record.as_object().end() ? kNull
                                                            : found->second;
      if (found == record.as_object().end() &&
          first.presence == Presence::Required) {
        throw EncodeError("required field '" + first.name + "' is missing",
                          row, column.label, row);
      }

      std::vector<EncodedEvent> events;
      encode_step(plan, 0, field, 0, 0, row, events);
      for (const EncodedEvent& event : events) {
        column.repetition_levels.push_back(event.repetition);
        column.definition_levels.push_back(event.definition);
        if (event.value) {
          column.values.push_back(*event.value);
        }
      }
    }
    columns.push_back(std::move(column));
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<Column>& columns) {
  return Decoder(schema).decode(columns);
}

std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<int>& repetition_levels,
                          const std::vector<int>& definition_levels,
                          const std::vector<Value>& values) {
  return decode(schema,
                std::vector<Column>({Column(std::vector<std::string>{},
                                           repetition_levels,
                                           definition_levels, values)}));
}

std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<std::string>& path,
                          const std::vector<int>& repetition_levels,
                          const std::vector<int>& definition_levels,
                          const std::vector<Value>& values) {
  return decode(schema, std::vector<Column>(
                            {Column(path, repetition_levels,
                                    definition_levels, values)}));
}

std::vector<Column> encode(const SchemaNode& schema,
                           const std::vector<Value>& rows) {
  return Encoder(schema).encode(rows);
}

}  // namespace dataeng
