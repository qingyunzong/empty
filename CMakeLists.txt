cmake_minimum_required(VERSION 3.20)
project(resource_batch CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(resource_batch INTERFACE)
target_include_directories(resource_batch INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

enable_testing()

add_executable(test_resource_batch tests/test_resource_batch.cpp)
target_link_libraries(test_resource_batch PRIVATE resource_batch)
target_compile_options(test_resource_batch PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME resource_batch COMMAND test_resource_batch)
