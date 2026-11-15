#include "schema.hpp"

#include <sstream>
#include <stdexcept>

namespace dataeng {

bool SchemaNode::addsDefLevel() const {
    return repetition != Repetition::Required;
}

SchemaNodePtr SchemaNode::child(const std::string& childName) const {
    for (const auto& node : children) {
        if (node->name == childName) {
            return node;
        }
    }
    return nullptr;
}

SchemaNodePtr Schema::makeStruct(std::string name, Repetition rep,
                                 std::vector<SchemaNodePtr> fields) {
    auto node = std::make_shared<SchemaNode>();
    node->name = std::move(name);
    node->kind = NodeKind::Struct;
    node->repetition = rep;
    node->children = std::move(fields);
    return node;
}

SchemaNodePtr Schema::makeList(std::string name, Repetition rep,
                               SchemaNodePtr element) {
    auto elementGroup = std::make_shared<SchemaNode>();
    elementGroup->name = "element";
    elementGroup->kind = NodeKind::Struct;
    elementGroup->repetition = Repetition::Repeated;
    elementGroup->children.push_back(std::move(element));

    auto node = std::make_shared<SchemaNode>();
    node->name = std::move(name);
    node->kind = NodeKind::List;
    node->repetition = rep;
    node->children.push_back(std::move(elementGroup));
    return node;
}

SchemaNodePtr Schema::makeMap(std::string name, Repetition rep,
                              SchemaNodePtr key, SchemaNodePtr value) {
    auto pairGroup = std::make_shared<SchemaNode>();
    pairGroup->name = "key_value";
    pairGroup->kind = NodeKind::Struct;
    pairGroup->repetition = Repetition::Repeated;
    pairGroup->children.push_back(std::move(key));
    pairGroup->children.push_back(std::move(value));

    auto node = std::make_shared<SchemaNode>();
    node->name = std::move(name);
    node->kind = NodeKind::Map;
    node->repetition = rep;
    node->children.push_back(std::move(pairGroup));
    return node;
}

SchemaNodePtr Schema::makePrimitive(std::string name, Repetition rep,
                                    PrimType type) {
    auto node = std::make_shared<SchemaNode>();
    node->name = std::move(name);
    node->kind = NodeKind::Primitive;
    node->repetition = rep;
    node->primitive = type;
    return node;
}

Schema::Schema(SchemaNodePtr root) : root_(std::move(root)) {
    freeze();
}

void Schema::freeze() {
    nodes_.clear();
    leaves_.clear();

    struct Cursor {
        const SchemaNode* node;
        int rep;
        int def;
    };
    std::vector<Cursor> stack;
    stack.push_back(Cursor{root_.get(), 0, 0});

    const SchemaNode* deepestLeaf = nullptr;

    while (!stack.empty()) {
        Cursor current = stack.back();
        stack.pop_back();

        auto* mutableNode = const_cast<SchemaNode*>(current.node);
        int rep = current.rep + (mutableNode->isRepeated() ? 1 : 0);
        int def = current.def + (mutableNode->addsDefLevel() ? 1 : 0);
        mutableNode->repLevel = rep;
        mutableNode->defLevel = def;
        mutableNode->maxRepLevel = rep;
        mutableNode->maxDefLevel = def;

        nodes_.push_back(current.node);
        if (mutableNode->kind == NodeKind::Primitive) {
            leaves_.push_back(current.node);
            if (!deepestLeaf || def > deepestLeaf->maxDefLevel) {
                deepestLeaf = current.node;
            }
        }

        for (int i = static_cast<int>(mutableNode->children.size()) - 1; i >= 0; --i) {
            auto& childNode = mutableNode->children[static_cast<std::size_t>(i)];
            childNode->parent = mutableNode;
            childNode->indexInParent = i;
            stack.push_back(Cursor{childNode.get(), rep, def});
        }
    }

    if (deepestLeaf) {
        const_cast<SchemaNode*>(root_.get())->maxRepLevel = deepestLeaf->repLevel;
        const_cast<SchemaNode*>(root_.get())->maxDefLevel = deepestLeaf->maxDefLevel;
    }
}

const SchemaNode* Schema::findPath(const std::vector<std::string>& path) const {
    const SchemaNode* current = root_.get();
    std::size_t start = 0;
    if (!path.empty() && path.front() == root_->name) {
        start = 1;
    }
    for (std::size_t p = start; p < path.size(); ++p) {
        const std::string& segment = path[p];
        const SchemaNode* next = nullptr;
        for (const auto& child : current->children) {
            if (child->name == segment) {
                next = child.get();
                break;
            }
        }
        if (!next) {
            return nullptr;
        }
        current = next;
    }
    return current;
}

const SchemaNode* Schema::findLeaf(const std::string& pathDot) const {
    std::vector<std::string> path;
    std::string segment;
    std::stringstream stream(pathDot);
    while (std::getline(stream, segment, '.')) {
        path.push_back(segment);
    }
    const SchemaNode* node = findPath(path);
    if (node && node->kind == NodeKind::Primitive) {
        return node;
    }
    return nullptr;
}

}  // namespace dataeng
