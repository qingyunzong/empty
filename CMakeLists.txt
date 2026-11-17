cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

option(DLKS_FORMAL_BUILD_TESTS "Build dlks_formal tests" ON)
option(DLKS_FORMAL_SANITIZERS "Enable ASan/UBSan for dlks_formal tests" ON)

if(DLKS_FORMAL_BUILD_TESTS)
  enable_testing()
  add_executable(dlks_formal_async_io_test tests/async_io_test.cpp)
  target_link_libraries(dlks_formal_async_io_test PRIVATE dlks_formal)
  add_test(NAME async_io COMMAND dlks_formal_async_io_test)
  if(DLKS_FORMAL_SANITIZERS)
    target_compile_options(dlks_formal_async_io_test PRIVATE
      -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra)
    target_link_options(dlks_formal_async_io_test PRIVATE
      -fsanitize=address,undefined)
    # 部分沙箱环境禁用 ptrace,LeakSanitizer 无法工作;
    # 配置期探测,仅在 LSan 不可用时关闭泄漏检查(其余检查保留)。
    set(_lsan_probe ${CMAKE_BINARY_DIR}/lsan_probe)
    file(WRITE ${_lsan_probe}.cpp "int main() { return 0; }\n")
    execute_process(
      COMMAND ${CMAKE_CXX_COMPILER} -fsanitize=address
              ${_lsan_probe}.cpp -o ${_lsan_probe}
      RESULT_VARIABLE _lsan_compile OUTPUT_QUIET ERROR_QUIET)
    if(_lsan_compile EQUAL 0)
      execute_process(COMMAND ${_lsan_probe}
        RESULT_VARIABLE _lsan_run OUTPUT_QUIET ERROR_QUIET)
      if(NOT _lsan_run EQUAL 0)
        set_tests_properties(async_io PROPERTIES
          ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0")
      endif()
    endif()
  endif()
endif()
