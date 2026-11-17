cmake_minimum_required(VERSION 3.20)
project(dlks_formal VERSION 1.0.0 LANGUAGES CXX)

add_library(dlks_formal INTERFACE)
add_library(dlks_formal::dlks_formal ALIAS dlks_formal)
target_compile_features(dlks_formal INTERFACE cxx_std_20)
target_include_directories(
    dlks_formal
    INTERFACE
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>)

include(CTest)
if(BUILD_TESTING)
    add_executable(dlks_formal_tests tests/column_codec_tests.cpp)
    target_link_libraries(dlks_formal_tests PRIVATE dlks_formal::dlks_formal)

    if(MSVC)
        target_compile_options(dlks_formal_tests PRIVATE /W4 /permissive-)
    else()
        target_compile_options(
            dlks_formal_tests PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
    endif()

    add_test(NAME dlks_formal_tests COMMAND dlks_formal_tests)
endif()
