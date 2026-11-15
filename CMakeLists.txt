cmake_minimum_required(VERSION 3.16)
project(dataeng LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(dataeng
  dataeng.cpp
  src/wire.cpp
  src/descriptor.cpp
  src/migration.cpp
  src/transform.cpp
  src/roundtrip.cpp
)
target_include_directories(dataeng PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

if(MSVC)
  target_compile_options(dataeng PRIVATE /W4)
else()
  target_compile_options(dataeng PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

add_executable(dataeng_tests tests/migration_test.cpp)
target_link_libraries(dataeng_tests PRIVATE dataeng)
add_test(NAME dataeng_tests COMMAND dataeng_tests)

add_executable(dataeng_fuzz tests/fuzz_test.cpp)
target_link_libraries(dataeng_fuzz PRIVATE dataeng)
add_test(NAME dataeng_fuzz COMMAND dataeng_fuzz)
