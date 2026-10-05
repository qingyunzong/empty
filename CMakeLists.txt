cmake_minimum_required(VERSION 3.20)
project(idx64 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(idx64 src/index.cpp)
target_include_directories(idx64 PUBLIC include)
target_compile_options(idx64 PRIVATE -Wall -Wextra -Wpedantic)

add_executable(idxcheck src/idxcheck.cpp)
target_link_libraries(idxcheck PRIVATE idx64)
target_compile_options(idxcheck PRIVATE -Wall -Wextra -Wpedantic)

add_executable(idxgen src/idxgen.cpp)
target_link_libraries(idxgen PRIVATE idx64)
target_compile_options(idxgen PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(unit_test tests/unit_test.cpp)
target_link_libraries(unit_test PRIVATE idx64)
target_compile_options(unit_test PRIVATE -Wall -Wextra -Wpedantic)

add_executable(crosscheck_test tests/crosscheck_test.cpp)
target_link_libraries(crosscheck_test PRIVATE idx64)
target_include_directories(crosscheck_test PRIVATE tests)
target_compile_options(crosscheck_test PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME unit COMMAND unit_test)
add_test(NAME crosscheck COMMAND crosscheck_test)
add_test(
  NAME end_to_end
  COMMAND ${CMAKE_COMMAND}
    -DIDXCHECK=$<TARGET_FILE:idxcheck>
    -DIDXGEN=$<TARGET_FILE:idxgen>
    -DWORK=${CMAKE_CURRENT_BINARY_DIR}/e2e
    -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/end_to_end.cmake)
