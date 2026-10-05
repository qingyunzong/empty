cmake_minimum_required(VERSION 3.20)
project(pngdec LANGUAGES CXX)

add_library(pngdec src/pngdec.cpp)
target_include_directories(pngdec PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(pngdec PUBLIC cxx_std_20)
set_target_properties(pngdec PROPERTIES CXX_EXTENSIONS OFF)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(pngdec PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

set(PNGDEC_TESTS
    test_filters
    test_chunking
    test_crc
    test_ihdr
    test_overflow
    test_stream)

foreach(t IN LISTS PNGDEC_TESTS)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE pngdec)
  target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  set_target_properties(${t} PROPERTIES CXX_EXTENSIONS OFF)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${t} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME ${t} COMMAND ${t})
endforeach()
