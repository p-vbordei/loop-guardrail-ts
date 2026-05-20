/**
 * Pure tool-call loop guardrail primitives for LLM agents.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import crypto from "node:crypto";

export const IDEMPOTENT_TOOL_NAMES = new Set([
  "read_file",
  "search_files",
  "web_search",
  "web_extract",
  "session_search",
  "browser_snapshot",
  "browser_console",
  "browser_get_images",
  "mcp_filesystem_read_file",
  "mcp_filesystem_read_text_file",
  "mcp_filesystem_read_multiple_files",
  "mcp_filesystem_list_directory",
  "mcp_filesystem_list_directory_with_sizes",
  "mcp_filesystem_directory_tree",
  "mcp_filesystem_get_file_info",
  "mcp_filesystem_search_files",
]);

export const MUTATING_TOOL_NAMES = new Set([
  "terminal",
  "execute_code",
  "write_file",
  "patch",
  "todo",
  "memory",
  "skill_manage",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_navigate",
  "send_message",
  "cronjob",
  "delegate_task",
  "process",
]);

export interface ToolCallGuardrailConfigOptions {
  warningsEnabled?: boolean;
  hardStopEnabled?: boolean;
  exactFailureWarnAfter?: number;
  exactFailureBlockAfter?: number;
  sameToolFailureWarnAfter?: number;
  sameToolFailureHaltAfter?: number;
  noProgressWarnAfter?: number;
  noProgressBlockAfter?: number;
  idempotentTools?: Set<string>;
  mutatingTools?: Set<string>;
}

export class ToolCallGuardrailConfig {
  public readonly warningsEnabled: boolean;
  public readonly hardStopEnabled: boolean;
  public readonly exactFailureWarnAfter: number;
  public readonly exactFailureBlockAfter: number;
  public readonly sameToolFailureWarnAfter: number;
  public readonly sameToolFailureHaltAfter: number;
  public readonly noProgressWarnAfter: number;
  public readonly noProgressBlockAfter: number;
  public readonly idempotentTools: Set<string>;
  public readonly mutatingTools: Set<string>;

  constructor(options?: ToolCallGuardrailConfigOptions) {
    this.warningsEnabled = options?.warningsEnabled ?? true;
    this.hardStopEnabled = options?.hardStopEnabled ?? false;
    this.exactFailureWarnAfter = options?.exactFailureWarnAfter ?? 2;
    this.exactFailureBlockAfter = options?.exactFailureBlockAfter ?? 5;
    this.sameToolFailureWarnAfter = options?.sameToolFailureWarnAfter ?? 3;
    this.sameToolFailureHaltAfter = options?.sameToolFailureHaltAfter ?? 8;
    this.noProgressWarnAfter = options?.noProgressWarnAfter ?? 2;
    this.noProgressBlockAfter = options?.noProgressBlockAfter ?? 5;
    this.idempotentTools = options?.idempotentTools ?? IDEMPOTENT_TOOL_NAMES;
    this.mutatingTools = options?.mutatingTools ?? MUTATING_TOOL_NAMES;
  }
}

export class ToolCallSignature {
  constructor(
    public readonly toolName: string,
    public readonly argsHash: string
  ) {}

  public static fromCall(toolName: string, args: Record<string, any> | null): ToolCallSignature {
    const canonical = canonicalToolArgs(args ?? {});
    const hash = crypto.createHash("sha256").update(canonical, "utf-8").digest("hex");
    return new ToolCallSignature(toolName, hash);
  }

  public toMetadata(): Record<string, string> {
    return { tool_name: this.toolName, args_hash: this.argsHash };
  }
}

export class ToolGuardrailDecision {
  constructor(
    public readonly action: "allow" | "warn" | "block" | "halt" = "allow",
    public readonly code: string = "allow",
    public readonly message: string = "",
    public readonly toolName: string = "",
    public readonly count: number = 0,
    public readonly signature: ToolCallSignature | null = null
  ) {}

  public get allowsExecution(): boolean {
    return this.action === "allow" || this.action === "warn";
  }

  public get shouldHalt(): boolean {
    return this.action === "block" || this.action === "halt";
  }

  public toMetadata(): Record<string, any> {
    const data: Record<string, any> = {
      action: this.action,
      code: this.code,
      message: this.message,
      tool_name: this.toolName,
      count: this.count,
    };
    if (this.signature !== null) {
      data.signature = this.signature.toMetadata();
    }
    return data;
  }
}

export function canonicalToolArgs(args: Record<string, any>): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new TypeError(`tool args must be a non-null object`);
  }
  const sortObject = (obj: any): any => {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sortObject);
    }
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj: Record<string, any> = {};
    for (const key of sortedKeys) {
      sortedObj[key] = sortObject(obj[key]);
    }
    return sortedObj;
  };
  return JSON.stringify(sortObject(args));
}

export function fileMutationResultLanded(toolName: string, result: unknown): boolean {
  if (!["write_file", "patch"].includes(toolName) || typeof result !== "string") {
    return false;
  }
  try {
    const data = JSON.parse(result.trim());
    if (typeof data !== "object" || data === null || data.error) {
      return false;
    }
    if (toolName === "write_file") {
      return "bytes_written" in data;
    }
    if (toolName === "patch") {
      return data.success === true;
    }
  } catch {
    return false;
  }
  return false;
}

export function classifyToolFailure(toolName: string, result: string | null): [boolean, string] {
  if (result === null) {
    return [false, ""];
  }
  if (fileMutationResultLanded(toolName, result)) {
    return [false, ""];
  }

  if (toolName === "terminal") {
    try {
      const data = JSON.parse(result.trim());
      if (typeof data === "object" && data !== null) {
        const exitCode = data.exit_code;
        if (exitCode !== undefined && exitCode !== 0) {
          return [true, ` [exit ${exitCode}]`];
        }
      }
    } catch {}
    return [false, ""];
  }

  if (toolName === "memory") {
    try {
      const data = JSON.parse(result.trim());
      if (typeof data === "object" && data !== null) {
        if (data.success === false && String(data.error || "").includes("exceed the limit")) {
          return [true, " [full]"];
        }
      }
    } catch {}
  }

  const lower = result.slice(0, 500).toLowerCase();
  if (lower.includes('"error"') || lower.includes('"failed"') || result.startsWith("Error")) {
    return [true, " [error]"];
  }

  return [false, ""];
}

export class ToolCallGuardrailController {
  private config: ToolCallGuardrailConfig;
  private exactFailureCounts = new Map<string, number>(); // Signature hash -> count
  private sameToolFailureCounts = new Map<string, number>(); // ToolName -> count
  private noProgress = new Map<string, { resultHash: string; repeatCount: number }>(); // Signature hash -> status
  private activeHaltDecision: ToolGuardrailDecision | null = null;

  constructor(config?: ToolCallGuardrailConfig) {
    this.config = config ?? new ToolCallGuardrailConfig();
  }

  public resetForTurn(): void {
    this.exactFailureCounts.clear();
    this.sameToolFailureCounts.clear();
    this.noProgress.clear();
    this.activeHaltDecision = null;
  }

  public get haltDecision(): ToolGuardrailDecision | null {
    return this.activeHaltDecision;
  }

  public beforeCall(toolName: string, args: Record<string, any> | null): ToolGuardrailDecision {
    const signature = ToolCallSignature.fromCall(toolName, args);
    if (!this.config.hardStopEnabled) {
      return new ToolGuardrailDecision("allow", "allow", "", toolName, 0, signature);
    }

    const exactCount = this.exactFailureCounts.get(signature.argsHash) ?? 0;
    if (exactCount >= this.config.exactFailureBlockAfter) {
      const decision = new ToolGuardrailDecision(
        "block",
        "repeated_exact_failure_block",
        `Blocked ${toolName}: the same tool call failed ${exactCount} times with identical arguments. Stop retrying it unchanged; change strategy or explain the blocker.`,
        toolName,
        exactCount,
        signature
      );
      this.activeHaltDecision = decision;
      return decision;
    }

    if (this.isIdempotent(toolName)) {
      const record = this.noProgress.get(signature.argsHash);
      if (record !== undefined) {
        const { repeatCount } = record;
        if (repeatCount >= this.config.noProgressBlockAfter) {
          const decision = new ToolGuardrailDecision(
            "block",
            "idempotent_no_progress_block",
            `Blocked ${toolName}: this read-only call returned the same result ${repeatCount} times. Stop repeating it unchanged; use the result already provided or try a different query.`,
            toolName,
            repeatCount,
            signature
          );
          this.activeHaltDecision = decision;
          return decision;
        }
      }
    }

    return new ToolGuardrailDecision("allow", "allow", "", toolName, 0, signature);
  }

  public afterCall(
    toolName: string,
    args: Record<string, any> | null,
    result: string | null,
    options?: { failed?: boolean }
  ): ToolGuardrailDecision {
    const signature = ToolCallSignature.fromCall(toolName, args);
    let failed = options?.failed;
    if (failed === undefined) {
      [failed] = classifyToolFailure(toolName, result);
    }

    if (failed) {
      const exactCount = (this.exactFailureCounts.get(signature.argsHash) ?? 0) + 1;
      this.exactFailureCounts.set(signature.argsHash, exactCount);
      this.noProgress.delete(signature.argsHash);

      const sameCount = (this.sameToolFailureCounts.get(toolName) ?? 0) + 1;
      this.sameToolFailureCounts.set(toolName, sameCount);

      if (this.config.hardStopEnabled && sameCount >= this.config.sameToolFailureHaltAfter) {
        const decision = new ToolGuardrailDecision(
          "halt",
          "same_tool_failure_halt",
          `Stopped ${toolName}: it failed ${sameCount} times this turn. Stop retrying the same failing tool path and choose a different approach.`,
          toolName,
          sameCount,
          signature
        );
        this.activeHaltDecision = decision;
        return decision;
      }

      if (this.config.warningsEnabled && exactCount >= this.config.exactFailureWarnAfter) {
        return new ToolGuardrailDecision(
          "warn",
          "repeated_exact_failure_warning",
          `${toolName} has failed ${exactCount} times with identical arguments. This looks like a loop; inspect the error and change strategy instead of retrying it unchanged.`,
          toolName,
          exactCount,
          signature
        );
      }

      if (this.config.warningsEnabled && sameCount >= this.config.sameToolFailureWarnAfter) {
        return new ToolGuardrailDecision(
          "warn",
          "same_tool_failure_warning",
          this.toolFailureRecoveryHint(toolName, sameCount),
          toolName,
          sameCount,
          signature
        );
      }

      return new ToolGuardrailDecision("allow", "allow", "", toolName, exactCount, signature);
    }

    this.exactFailureCounts.delete(signature.argsHash);
    this.sameToolFailureCounts.delete(toolName);

    if (!this.isIdempotent(toolName)) {
      this.noProgress.delete(signature.argsHash);
      return new ToolGuardrailDecision("allow", "allow", "", toolName, 0, signature);
    }

    const resHash = this.computeResultHash(result);
    const previous = this.noProgress.get(signature.argsHash);
    let repeatCount = 1;
    if (previous !== undefined && previous.resultHash === resHash) {
      repeatCount = previous.repeatCount + 1;
    }
    this.noProgress.set(signature.argsHash, { resultHash: resHash, repeatCount });

    if (this.config.warningsEnabled && repeatCount >= this.config.noProgressWarnAfter) {
      return new ToolGuardrailDecision(
        "warn",
        "idempotent_no_progress_warning",
        `${toolName} returned the same result ${repeatCount} times. Use the result already provided or change the query instead of repeating it unchanged.`,
        toolName,
        repeatCount,
        signature
      );
    }

    return new ToolGuardrailDecision("allow", "allow", "", toolName, repeatCount, signature);
  }

  private isIdempotent(toolName: string): boolean {
    if (this.config.mutatingTools.has(toolName)) {
      return false;
    }
    return this.config.idempotentTools.has(toolName);
  }

  private computeResultHash(result: string | null): string {
    let canonical = result ?? "";
    try {
      const parsed = JSON.parse(canonical.trim());
      if (typeof parsed === "object" && parsed !== null) {
        canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
      }
    } catch {}
    return crypto.createHash("sha256").update(canonical, "utf-8").digest("hex");
  }

  private toolFailureRecoveryHint(toolName: string, count: number): string {
    const common = `${toolName} has failed ${count} times this turn. This looks like a loop. Do not switch to text-only replies; keep using tools, but diagnose before retrying. First inspect the latest error/output and verify your assumptions. `;
    if (toolName === "terminal") {
      return (
        common +
        "For terminal failures, run a small diagnostic such as `pwd && ls -la` in the same tool, then try an absolute path, a simpler command, a different working directory, or a different tool such as read_file/write_file/patch."
      );
    }
    return (
      common +
      "Try different arguments, a narrower query/path, an absolute path when relevant, or a different tool that can make progress. If the blocker is external, report the blocker after one diagnostic attempt instead of repeating the same failing path."
    );
  }
}

export function toolguardSyntheticResult(decision: ToolGuardrailDecision): string {
  return JSON.stringify({
    error: decision.message,
    guardrail: decision.toMetadata(),
  });
}

export function appendToolguardGuidance(result: string, decision: ToolGuardrailDecision): string {
  if (!["warn", "halt"].includes(decision.action) || !decision.message) {
    return result;
  }
  const label = decision.action === "halt" ? "Tool loop hard stop" : "Tool loop warning";
  const suffix = `\n\n[${label}: ${decision.code}; count=${decision.count}; ${decision.message}]`;
  return (result ?? "") + suffix;
}
