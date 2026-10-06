cmake_minimum_required(VERSION 3.16)
project(loopfind LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(cfg src/graph.cpp src/analysis.cpp)
target_include_directories(cfg PUBLIC src)
target_compile_options(cfg PRIVATE -Wall -Wextra)

add_executable(loopfind src/main.cpp)
target_link_libraries(loopfind PRIVATE cfg)

enable_testing()

add_executable(test_analysis tests/test_analysis.cpp)
target_link_libraries(test_analysis PRIVATE cfg)
target_compile_options(test_analysis PRIVATE -Wall -Wextra)
add_test(NAME unit COMMAND test_analysis)

add_test(NAME cli_nested
         COMMAND loopfind ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/nested.cfg)
set_tests_properties(cli_nested PROPERTIES
    PASS_REGULAR_EXPRESSION "  natural-loop header=2")

add_test(NAME cli_irreducible
         COMMAND loopfind ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/irreducible.cfg)
set_tests_properties(cli_irreducible PROPERTIES
    PASS_REGULAR_EXPRESSION "irreducible-loop entries={1 2}")

add_test(NAME cli_multi_backedge
         COMMAND loopfind ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/multi_backedge.cfg)
set_tests_properties(cli_multi_backedge PROPERTIES
    PASS_REGULAR_EXPRESSION "latches={2 3}")

add_test(NAME cli_split
         COMMAND loopfind --split ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/irreducible.cfg)
set_tests_properties(cli_split PROPERTIES
    PASS_REGULAR_EXPRESSION "input-unchanged: yes")

add_test(NAME cli_missing_file COMMAND loopfind does-not-exist.cfg)
set_tests_properties(cli_missing_file PROPERTIES WILL_FAIL TRUE)
