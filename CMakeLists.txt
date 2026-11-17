cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

include(CTest)
if(BUILD_TESTING)
    add_executable(dlks_formal_tests tests/test_formal.cpp)
    target_link_libraries(dlks_formal_tests PRIVATE dlks_formal)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(dlks_formal_tests PRIVATE
            -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
    endif()
    add_test(NAME dlks_formal_tests COMMAND dlks_formal_tests)
endif()
