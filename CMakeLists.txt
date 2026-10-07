cmake_minimum_required(VERSION 3.20)
project(page_compressor CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(pgc src/page_compressor.cpp)
target_include_directories(pgc PUBLIC include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(pgc PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

add_executable(pgc_tests tests/pgc_tests.cpp)
target_link_libraries(pgc_tests PRIVATE pgc)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(pgc_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

set(PGC_TEST_CASES
    round_trip_basic
    same_key_version_order
    empty_input
    prefix_compression_saves_space
    page_boundary_exact_fit
    page_boundary_one_byte_under_budget
    critical_page_size_for_single_record
    prefix_compression_extends_page_capacity
    oversized_record_rejected
    oversized_key_rejected
    checksum_detects_corruption
    corrupt_structure_detected
    file_checksum_detects_corruption
    publish_load_roundtrip
    failed_publish_leaves_no_file
    failed_publish_preserves_existing_file
)

foreach(case IN LISTS PGC_TEST_CASES)
    add_test(NAME ${case} COMMAND pgc_tests ${case})
endforeach()
