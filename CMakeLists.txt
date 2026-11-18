cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)

option(DLKS_FORMAL_BUILD_TESTS "Build dlks_formal tests" ON)
if(DLKS_FORMAL_BUILD_TESTS)
    enable_testing()
    add_executable(consistent_hash_ring_test
        tests/consistent_hash_ring_test.cpp)
    target_link_libraries(consistent_hash_ring_test PRIVATE dlks_formal)
    find_package(Threads REQUIRED)
    target_link_libraries(consistent_hash_ring_test PRIVATE Threads::Threads)
    add_test(NAME consistent_hash_ring
        COMMAND consistent_hash_ring_test)
endif()
