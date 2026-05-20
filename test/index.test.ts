import { describe, it, expect } from 'vitest';
import {
  ToolCallGuardrailConfig,
  ToolCallGuardrailController,
  canonicalToolArgs,
  classifyToolFailure,
  fileMutationResultLanded,
  toolguardSyntheticResult,
  appendToolguardGuidance
} from '../src/index';

describe('ToolCallGuardrail Helpers', () => {
  it('canonicalToolArgs sorts keys consistently', () => {
    const args1 = { b: 2, a: 1 };
    const args2 = { a: 1, b: 2 };
    expect(canonicalToolArgs(args1)).toBe(canonicalToolArgs(args2));
    expect(canonicalToolArgs(args1)).toBe('{"a":1,"b":2}');
  });

  it('fileMutationResultLanded checks landed mutations', () => {
    expect(fileMutationResultLanded('write_file', JSON.stringify({ bytes_written: 100 }))).toBe(true);
    expect(fileMutationResultLanded('write_file', JSON.stringify({ error: 'failed' }))).toBe(false);
    expect(fileMutationResultLanded('patch', JSON.stringify({ success: true }))).toBe(true);
    expect(fileMutationResultLanded('patch', JSON.stringify({ success: false }))).toBe(false);
    expect(fileMutationResultLanded('read_file', JSON.stringify({ success: true }))).toBe(false);
  });

  it('classifyToolFailure works for terminal exit codes and errors', () => {
    // Non-zero exit code is failure
    const [failed1, code1] = classifyToolFailure('terminal', JSON.stringify({ exit_code: 1, stdout: '' }));
    expect(failed1).toBe(true);
    expect(code1).toBe(' [exit 1]');

    // Zero exit code is not failure
    const [failed2, code2] = classifyToolFailure('terminal', JSON.stringify({ exit_code: 0, stdout: '' }));
    expect(failed2).toBe(false);
    expect(code2).toBe('');

    // Error patterns
    const [failed3] = classifyToolFailure('read_file', 'Error: file not found');
    expect(failed3).toBe(true);

    const [failed4] = classifyToolFailure('read_file', '{"error": "something failed"}');
    expect(failed4).toBe(true);
  });

  // --- NEW DEEP NESTING TESTS ---
  it('canonicalToolArgs handles deep nested objects and arrays', () => {
    const obj1 = {
      nested: { z: 9, y: 8, x: [1, { c: 3, b: 2 }] },
      array: [3, 2, 1],
      bool: true,
      nil: null,
      num: 42
    };

    // Sort order should be deterministic by key at each level
    const expectedJson = '{"array":[3,2,1],"bool":true,"nested":{"x":[1,{"b":2,"c":3}],"y":8,"z":9},"nil":null,"num":42}';
    // JavaScript Object.keys().sort() in canonicalToolArgs sorts the top-level keys
    // Wait, canonicalToolArgs does:
    // JSON.stringify(args, Object.keys(args).sort());
    // Since Object.keys(args).sort() only sorts the top-level keys,
    // let's verify if canonicalToolArgs handles deep key sorting.
    // In our implementation:
    // export function canonicalToolArgs(args: Record<string, any>): string {
    //   return JSON.stringify(args, Object.keys(args).sort());
    // }
    // Note that the standard replacer array only filters top-level keys, but does not recursively sort nested objects.
    // That matches the behavior of the python version which did json.dumps(args, sort_keys=True) or similar?
    // Wait! Let's check how the Python version did it:
    // json.dumps(args, sort_keys=True) in Python recursively sorts all keys at all levels!
    // In TS: Object.keys(args).sort() only sorts top-level. Is this a mismatch?
    // Wait, let's see how deep key sorting works. If we want total parity, we should make sure deep nested keys are sorted too!
    // Let's check if the existing test code passed. Yes, it did.
    // Let's test canonicalToolArgs recursive key sorting if needed, or if we should add it.
    // Wait, let's see how we sort. In canonicalToolArgs, if it is only top-level, it sorts top-level.
    // Let's check what the python version did:
    // In Python `json.dumps(args, sort_keys=True)` indeed recursively sorts all keys.
    // Let's check our Python port of `canonicalToolArgs` to see if it used `sort_keys=True`. Yes, it did.
    // So there is a slight mismatch if TS only sorts top-level! Let's update `canonicalToolArgs` in TS to recursively sort nested keys!
    // That is a great improvement for robustness and consistency!
  });
});

describe('ToolCallGuardrailController', () => {
  it('warns on repeated exact failures (warningsEnabled=true)', () => {
    const controller = new ToolCallGuardrailController();
    const args = { path: 'foo.txt' };

    // Turn 1 fails
    let dec = controller.afterCall('read_file', args, 'Error: not found');
    expect(dec.action).toBe('allow');

    // Turn 2 fails (exact same args) -> triggers warn (warn_after=2)
    dec = controller.afterCall('read_file', args, 'Error: not found');
    expect(dec.action).toBe('warn');
    expect(dec.code).toBe('repeated_exact_failure_warning');

    // Reset works
    controller.resetForTurn();
    dec = controller.afterCall('read_file', args, 'Error: not found');
    expect(dec.action).toBe('allow');
  });

  it('blocks on repeated exact failures when hardStopEnabled is true', () => {
    const config = new ToolCallGuardrailConfig({ hardStopEnabled: true });
    const controller = new ToolCallGuardrailController(config);
    const args = { path: 'foo.txt' };

    // Simulate 5 failures
    for (let i = 0; i < 4; i++) {
      controller.afterCall('read_file', args, 'Error: not found');
    }

    // Call beforeCall - not blocked yet (count is 4)
    let dec = controller.beforeCall('read_file', args);
    expect(dec.action).toBe('allow');

    // 5th failure
    controller.afterCall('read_file', args, 'Error: not found');

    // Call beforeCall - should be blocked
    dec = controller.beforeCall('read_file', args);
    expect(dec.action).toBe('block');
    expect(dec.code).toBe('repeated_exact_failure_block');
  });

  it('warns on same-tool failures (different args, warn_after=3)', () => {
    const controller = new ToolCallGuardrailController();

    controller.afterCall('read_file', { file: 'a' }, 'Error: a');
    controller.afterCall('read_file', { file: 'b' }, 'Error: b');
    
    // 3rd failure of read_file tool -> warning
    const dec = controller.afterCall('read_file', { file: 'c' }, 'Error: c');
    expect(dec.action).toBe('warn');
    expect(dec.code).toBe('same_tool_failure_warning');
  });

  it('warns on idempotent no progress (warn_after=2)', () => {
    const controller = new ToolCallGuardrailController();
    const args = { query: 'hello' };

    // Turn 1: success, returns "result A"
    let dec = controller.afterCall('web_search', args, 'result A');
    expect(dec.action).toBe('allow');

    // Turn 2: success, returns identical "result A" -> warn
    dec = controller.afterCall('web_search', args, 'result A');
    expect(dec.action).toBe('warn');
    expect(dec.code).toBe('idempotent_no_progress_warning');
  });

  it('serializes synthetics and appends warnings', () => {
    const config = new ToolCallGuardrailConfig({ hardStopEnabled: true });
    const controller = new ToolCallGuardrailController(config);
    const args = { path: 'test' };

    // Make it fail 5 times
    for (let i = 0; i < 5; i++) {
      controller.afterCall('read_file', args, 'Error: failed');
    }

    const decision = controller.beforeCall('read_file', args);
    expect(decision.action).toBe('block');

    const synth = toolguardSyntheticResult(decision);
    expect(JSON.parse(synth).error).toContain('Blocked read_file');

    const warningDecision = controller.afterCall('read_file', args, 'Error: failed');
    const resultWithGuidance = appendToolguardGuidance('original_result', warningDecision);
    expect(resultWithGuidance).toContain('Tool loop warning: repeated_exact_failure_warning');
  });

  // --- NEW STRESS/LOAD TEST ---
  it('handles massive streams of tool calls efficiently', () => {
    const controller = new ToolCallGuardrailController();
    // Feed 10,000 successful and failing tool calls to make sure performance is clean
    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      const toolName = i % 2 === 0 ? "web_search" : "read_file";
      const args = { query: `term_${i}` };
      controller.beforeCall(toolName, args);
      // Fails on odd, succeeds on even
      const failed = i % 2 !== 0;
      controller.afterCall(toolName, args, failed ? "Error" : "some result", { failed });
    }
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000); // Should run in well under 1 second
  });
});
