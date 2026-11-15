#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "value.hpp"

namespace dataeng {

enum class Repetition { Required, Optional, Repeated };

enum class NodeKind { Struct, List, Map, Primitive };

enum class PrimType { Boolean, Int64, Double, String };

struct SchemaNode;
using SchemaNodePtr = std::shared_ptr<SchemaNode>;

struct SchemaNode {
    std::string name;
    NodeKind kind = NodeKind::Struct;
    Repetition repetition = Repetition::Required;
    PrimType primitive = PrimType::Int64;
    std::vector<SchemaNodePtr> children;

    SchemaNode* parent = nullptr;
    int indexInParent = -1;
    int repLevel = 0;
    int defLevel = 0;
    int maxRepLevel = 0;
    int maxDefLevel = 0;

    bool addsDefLevel() const;
    bool isRepeated() const { return repetition == Repetition::Repeated; }
    bool isOptional() const { return repetition == Repetition::Optional; }

    SchemaNodePtr child(const std::string& childName) const;
};

class Schema {
public:
    explicit Schema(SchemaNodePtr root);

    const SchemaNode& root() const { return *root_; }
    const std::vector<const SchemaNode*>& leaves() const { return leaves_; }
    const std::vector<const SchemaNode*>& nodes() const { return nodes_; }

    const SchemaNode* findPath(const std::vector<std::string>& path) const;
    const SchemaNode* findLeaf(const std::string& pathDot) const;

    static SchemaNodePtr makeStruct(std::string name, Repetition rep,
                                    std::vector<SchemaNodePtr> fields);
    static SchemaNodePtr makeList(std::string name, Repetition rep,
                                  SchemaNodePtr element);
    static SchemaNodePtr makeMap(std::string name, Repetition rep,
                                 SchemaNodePtr key, SchemaNodePtr value);
    static SchemaNodePtr makePrimitive(std::string name, Repetition rep,
                                       PrimType type);

private:
    void freeze();

    SchemaNodePtr root_;
    std::vector<const SchemaNode*> nodes_;
    std::vector<const SchemaNode*> leaves_;
};

}  // namespace dataeng
