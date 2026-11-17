cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
target_include_directories(
    dlks_formal
    INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

include(CTest)

if(BUILD_TESTING)
    add_executable(dlks_hash_join_tests tests/hash_join_tests.cpp)
    target_link_libraries(dlks_hash_join_tests PRIVATE dlks_formal)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(
            dlks_hash_join_tests
            PRIVATE -Wall -Wextra -Wpedantic
        )
    endif()
    add_test(NAME dlks_hash_join_tests COMMAND dlks_hash_join_tests)
endif()
