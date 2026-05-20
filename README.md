# loop-guardrail

A pure, side-effect-free sliding-window loop detection and recovery guardrail system for LLM agent tool calls.

## License

Apache License 2.0 (100% independent and open-source).

## Features

- **Exact Failure Tracking**: Detects when an LLM retries the *exact same tool call* with *identical arguments* and it continues to fail.
- **Same-Tool Failure Tracking**: Detects when a specific tool fails repeatedly with *different arguments* (indicates a general tool path failure or incorrect environment assumptions).
- **Idempotent No-Progress Tracking**: Detects when read-only (idempotent) tool calls (like search, read_file) return the *exact same content* repeatedly, preventing useless duplicate reads.
- **Circuit Breaker halts**: Support for warning thresholds (returns action guidance) or hard block/halt stops.
- **Synthetics and Guidance Helpers**: Standard formatting to inject guardrail feedback directly back to the LLM agent context to break the loop programmatically.

## Installation

```bash
npm install loop-guardrail
```

## Usage

### 1. Initialize and Manage Turn State

Instantiate a stateful `ToolCallGuardrailController` for your agent execution session, and reset it at the start of every message turn.

```typescript
import { 
  ToolCallGuardrailController, 
  ToolCallGuardrailConfig,
  toolguardSyntheticResult,
  appendToolguardGuidance
} from 'loop-guardrail';

const config = new ToolCallGuardrailConfig({
  hardStopEnabled: true, // Circuit breaker mode
});
const guardrail = new ToolCallGuardrailController(config);

// Inside your agent message loop:
async function runTurn() {
  guardrail.resetForTurn();

  const toolCalls = getToolCallsFromLlm();
  for (const call of toolCalls) {
    // 1. Run pre-execution checks
    const decision = guardrail.beforeCall(call.name, call.arguments);
    
    if (decision.shouldHalt) {
      // Return synthetic block result to the LLM
      const synthResult = toolguardSyntheticResult(decision);
      sendToLlm(synthResult);
      continue;
    }

    // 2. Execute tool
    const result = await executeTool(call.name, call.arguments);

    // 3. Register outcome
    const afterDecision = guardrail.afterCall(call.name, call.arguments, result);
    
    if (afterDecision.action === "warn") {
      // Append warnings/hints directly to the tool results
      const guidedResult = appendToolguardGuidance(result, afterDecision);
      sendToLlm(guidedResult);
    } else {
      sendToLlm(result);
    }
  }
}
```

### 2. Failure Classification

By default, the controller auto-classifies failures from output text (checking for standard JSON errors, non-zero shell exit codes, and `"error"` / `"failed"` substrings). 

You can also pass an explicit `failed` flag if your orchestrator handles errors natively:

```typescript
guardrail.afterCall("read_file", { path: "missing.txt" }, null, { failed: true });
```
