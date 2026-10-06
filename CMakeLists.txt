cmake_minimum_required(VERSION 3.20)
project(bitemporal_inventory CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(bitemporal_store INTERFACE)
target_include_directories(bitemporal_store INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(bitemporal_demo src/main.cpp)
target_link_libraries(bitemporal_demo PRIVATE bitemporal_store)

enable_testing()
add_executable(test_bitemporal tests/test_bitemporal.cpp)
target_link_libraries(test_bitemporal PRIVATE bitemporal_store)
add_test(NAME bitemporal COMMAND test_bitemporal)
