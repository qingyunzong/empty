cmake_minimum_required(VERSION 3.16)
project(manhattan_path LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(manhattan_path INTERFACE)
target_include_directories(manhattan_path INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra)
endif()

enable_testing()

add_executable(path_unit_tests tests/test_unit.cpp)
target_link_libraries(path_unit_tests PRIVATE manhattan_path)
add_test(NAME unit COMMAND path_unit_tests)

add_executable(path_random_tests tests/test_random.cpp)
target_link_libraries(path_random_tests PRIVATE manhattan_path)
add_test(NAME random_seed_1 COMMAND path_random_tests 1)
add_test(NAME random_seed_42 COMMAND path_random_tests 42)
add_test(NAME random_seed_2026 COMMAND path_random_tests 2026)
