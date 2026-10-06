cmake_minimum_required(VERSION 3.16)
project(inspector_cli CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(inspector src/inspector.cpp)
target_include_directories(inspector PUBLIC src)
target_compile_options(inspector PRIVATE -Wall -Wextra)

add_executable(inspector-cli src/main.cpp)
target_link_libraries(inspector-cli PRIVATE inspector)
target_compile_options(inspector-cli PRIVATE -Wall -Wextra)

enable_testing()

add_executable(inspector_tests tests/test_inspector.cpp)
target_link_libraries(inspector_tests PRIVATE inspector)
target_compile_options(inspector_tests PRIVATE -Wall -Wextra)
add_test(NAME unit COMMAND inspector_tests)

add_test(NAME cli_sample
         COMMAND inspector-cli ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/sample1.txt)
set_tests_properties(cli_sample PROPERTIES
  PASS_REGULAR_EXPRESSION "status: ok\ncost: 5")

add_test(NAME cli_unreachable
         COMMAND inspector-cli ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/unreachable.txt)
set_tests_properties(cli_unreachable PROPERTIES
  PASS_REGULAR_EXPRESSION "status: unreachable")
