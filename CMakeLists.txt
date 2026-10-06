cmake_minimum_required(VERSION 3.20)
project(temporal_inventory CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(temporal_store INTERFACE)
target_include_directories(temporal_store INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(temporal_store INTERFACE -Wall -Wextra -Wpedantic)

add_executable(temporal_demo src/main.cpp)
target_link_libraries(temporal_demo PRIVATE temporal_store)

enable_testing()
add_executable(temporal_tests tests/test_store.cpp)
target_link_libraries(temporal_tests PRIVATE temporal_store)
add_test(NAME temporal_tests COMMAND temporal_tests)
