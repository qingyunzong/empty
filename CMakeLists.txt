cmake_minimum_required(VERSION 3.20)
project(sigconv CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(sigconv_core INTERFACE)
target_include_directories(sigconv_core INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(sigconv_core INTERFACE -Wall -Wextra)

add_executable(sigconv src/main.cpp)
target_link_libraries(sigconv PRIVATE sigconv_core)

enable_testing()

add_executable(test_convolve tests/test_convolve.cpp)
target_link_libraries(test_convolve PRIVATE sigconv_core)
add_test(NAME unit COMMAND test_convolve)
set_tests_properties(unit PROPERTIES TIMEOUT 300)

find_program(BASH_PROGRAM bash)
if(BASH_PROGRAM)
    add_test(NAME cli COMMAND ${BASH_PROGRAM}
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_test.sh $<TARGET_FILE:sigconv>)
endif()
