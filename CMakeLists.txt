cmake_minimum_required(VERSION 3.16)
project(dlks_q244 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(mpegts_section_assembler
    src/section_assembler.cpp
)
target_include_directories(mpegts_section_assembler PUBLIC include)
target_compile_options(mpegts_section_assembler PRIVATE -Wall -Wextra -Wpedantic)

add_executable(test_section_assembler
    tests/test_section_assembler.cpp
)
target_link_libraries(test_section_assembler PRIVATE mpegts_section_assembler)
target_compile_options(test_section_assembler PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME section_assembler COMMAND test_section_assembler)
