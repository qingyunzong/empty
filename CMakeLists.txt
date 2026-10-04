cmake_minimum_required(VERSION 3.16)
project(branch_shortening CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(branch INTERFACE)
target_include_directories(branch INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(branch_demo src/main.cpp)
target_link_libraries(branch_demo PRIVATE branch)

add_executable(branch_tests tests/tests.cpp)
target_link_libraries(branch_tests PRIVATE branch)

enable_testing()
add_test(NAME unit_tests COMMAND branch_tests)
add_test(NAME demo_seed_default COMMAND branch_demo)
add_test(NAME demo_seed_1 COMMAND branch_demo 1)
add_test(NAME demo_seed_42 COMMAND branch_demo 42)
