cmake_minimum_required(VERSION 3.16)
project(dataeng LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_library(ZSTD_LIBRARY NAMES zstd libzstd.so.1 REQUIRED)

add_library(dataeng dataeng.cpp)
target_include_directories(dataeng PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(dataeng PUBLIC "${ZSTD_LIBRARY}")

enable_testing()
add_executable(dataeng_seekable_test test_seekable.cpp)
target_link_libraries(dataeng_seekable_test PRIVATE dataeng)
add_test(NAME seekable COMMAND dataeng_seekable_test)
