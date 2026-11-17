cmake_minimum_required(VERSION 3.20)
project(dlks_formal VERSION 0.1.0 LANGUAGES CXX)

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
    add_executable(dlks_formal_flow_control_test tests/flow_control_test.cpp)
    target_link_libraries(dlks_formal_flow_control_test PRIVATE dlks_formal::dlks_formal)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(
            dlks_formal_flow_control_test
            PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME flow_control COMMAND dlks_formal_flow_control_test)
endif()
