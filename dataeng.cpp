#include "dataeng.hpp"

namespace dataeng {

template struct DictionaryBatch<std::string>;
template struct UnifiedBatch<std::string>;
template class BasicDictionaryUnifier<std::string>;
template std::vector<std::optional<std::string>> DecodeBatch<std::string>(
    const DictionaryBatch<std::string>&);

}  // namespace dataeng
