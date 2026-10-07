cmake_minimum_required(VERSION 3.20)
project(mex_counter CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(mex_counter INTERFACE)
target_include_directories(mex_counter INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(mex_cli src/main.cpp)
target_link_libraries(mex_cli PRIVATE mex_counter)

include(CTest)
if(BUILD_TESTING)
    add_executable(mex_tests tests/mex_tests.cpp)
    target_link_libraries(mex_tests PRIVATE mex_counter)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(mex_tests PRIVATE -Wall -Wextra -Wpedantic)
        target_compile_options(mex_cli PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME mex_tests COMMAND mex_tests)
endif()
