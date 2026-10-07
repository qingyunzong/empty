cmake_minimum_required(VERSION 3.20)
project(ammo_alloc_sim CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(simcore
    src/scenario.cpp
    src/solver.cpp
    src/bruteforce.cpp
)
target_include_directories(simcore PUBLIC src)
target_compile_options(simcore PRIVATE -Wall -Wextra -Wpedantic)

add_executable(simtool src/main.cpp)
target_link_libraries(simtool PRIVATE simcore)
target_compile_options(simtool PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(simtests tests/test_main.cpp)
target_link_libraries(simtests PRIVATE simcore)
target_compile_options(simtests PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME unit COMMAND simtests)

add_test(NAME cli_example
    COMMAND simtool ${CMAKE_CURRENT_SOURCE_DIR}/scenarios/example.txt --verify)
set_tests_properties(cli_example PROPERTIES PASS_REGULAR_EXPRESSION "VERIFY PASS")
