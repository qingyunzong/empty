add_executable(dlks_formal_tests test_congestion_control.cpp)
target_link_libraries(dlks_formal_tests PRIVATE dlks_formal)
target_compile_features(dlks_formal_tests PRIVATE cxx_std_20)

if(MSVC)
  target_compile_options(dlks_formal_tests PRIVATE /W4 /permissive-)
else()
  target_compile_options(dlks_formal_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_test(NAME dlks_formal.unit COMMAND dlks_formal_tests)

