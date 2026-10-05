# go test ./... 实际结果

日期：2026-10-05，Go 1.27.1 linux/amd64

```
=== RUN   TestHandWrittenScopeModel
=== RUN   TestHandWrittenScopeModel/global_lookup
=== RUN   TestHandWrittenScopeModel/lambda_param_shadows_global
=== RUN   TestHandWrittenScopeModel/let_shadows_global
=== RUN   TestHandWrittenScopeModel/let_initializers_see_outer_env
=== RUN   TestHandWrittenScopeModel/nested_let_shadows
=== RUN   TestHandWrittenScopeModel/closure_captures_definition_env
=== RUN   TestHandWrittenScopeModel/local_define_in_let_body
=== RUN   TestHandWrittenScopeModel/recursive_closure
--- PASS: TestHandWrittenScopeModel (0.00s)
    --- PASS: TestHandWrittenScopeModel/global_lookup (0.00s)
    --- PASS: TestHandWrittenScopeModel/lambda_param_shadows_global (0.00s)
    --- PASS: TestHandWrittenScopeModel/let_shadows_global (0.00s)
    --- PASS: TestHandWrittenScopeModel/let_initializers_see_outer_env (0.00s)
    --- PASS: TestHandWrittenScopeModel/nested_let_shadows (0.00s)
    --- PASS: TestHandWrittenScopeModel/closure_captures_definition_env (0.00s)
    --- PASS: TestHandWrittenScopeModel/local_define_in_let_body (0.00s)
    --- PASS: TestHandWrittenScopeModel/recursive_closure (0.00s)
=== RUN   TestEnvModelByHand
--- PASS: TestEnvModelByHand (0.00s)
=== RUN   TestArgsEvaluatedInCallerEnv
=== RUN   TestArgsEvaluatedInCallerEnv/caller_local_is_the_argument_value
=== RUN   TestArgsEvaluatedInCallerEnv/argument_expression_computed_at_call_site
=== RUN   TestArgsEvaluatedInCallerEnv/argument_value_immune_to_template_binders
--- PASS: TestArgsEvaluatedInCallerEnv (0.00s)
    --- PASS: TestArgsEvaluatedInCallerEnv/caller_local_is_the_argument_value (0.00s)
    --- PASS: TestArgsEvaluatedInCallerEnv/argument_expression_computed_at_call_site (0.00s)
    --- PASS: TestArgsEvaluatedInCallerEnv/argument_value_immune_to_template_binders (0.00s)
=== RUN   TestExpansionDoesNotCaptureCallerLocals
=== RUN   TestExpansionDoesNotCaptureCallerLocals/template_free_symbol_resolves_at_definition_site
=== RUN   TestExpansionDoesNotCaptureCallerLocals/introduced_binder_renamed,_caller_local_untouched
=== RUN   TestExpansionDoesNotCaptureCallerLocals/nested_macro_free_symbol_not_captured
--- PASS: TestExpansionDoesNotCaptureCallerLocals (0.00s)
    --- PASS: TestExpansionDoesNotCaptureCallerLocals/template_free_symbol_resolves_at_definition_site (0.00s)
    --- PASS: TestExpansionDoesNotCaptureCallerLocals/introduced_binder_renamed,_caller_local_untouched (0.00s)
    --- PASS: TestExpansionDoesNotCaptureCallerLocals/nested_macro_free_symbol_not_captured (0.00s)
=== RUN   TestHygienicRenamingStructure
--- PASS: TestHygienicRenamingStructure (0.00s)
=== RUN   TestRecursiveExpansionChain
=== RUN   TestRecursiveExpansionChain/self_recursion
=== RUN   TestRecursiveExpansionChain/mutual_recursion
--- PASS: TestRecursiveExpansionChain (0.00s)
    --- PASS: TestRecursiveExpansionChain/self_recursion (0.00s)
    --- PASS: TestRecursiveExpansionChain/mutual_recursion (0.00s)
=== RUN   TestStepBudget
=== RUN   TestStepBudget/infinite_macro_recursion_exhausts_budget
=== RUN   TestStepBudget/same_program_closes_with_sufficient_budget
--- PASS: TestStepBudget (0.00s)
    --- PASS: TestStepBudget/infinite_macro_recursion_exhausts_budget (0.00s)
    --- PASS: TestStepBudget/same_program_closes_with_sufficient_budget (0.00s)
PASS
ok  	macrolib	0.010s
```
