# PI-247 ENHANCEMENT PLAN: TOOL-DEPENDENT AUTONOMY

## GOAL
Transform pi-247 from an intellectually capable agent with rich tool access into a truly autonomous, tool-dependent system that self-verifies, learns from experience, and automatically recovers from errors — embodying the Pareto principle where 20% of improvements yield 80% of autonomy gains.

## CONSTRAINTS
- Must follow existing DRY+LEAN+SOLID+KISS principles
- Must respect current codebase structure and extension system
- Must not break existing functionality
- Must enhance, not replace, current tool capabilities
- Must work within the existing agent loop and hook architecture
- Changes should be additive where possible, minimal when modifying

## PROGRESS

### DONE
- [x] Deep-dive into existing verification/error patterns in pi-247
- [x] Audit existing memory system and compaction for learning potential
- [x] Map error recovery gaps and existing error parsing
- [x] Web research: how top coding agents implement verification, memory, error recovery
- [x] 5 Whys root cause analysis for each Pareto point

### WIP
- [ ] Write final workplan to PLAN.md

### BLOCKED
- None

## DECISIONS
- **[Verification Hook Approach]**: Implement as PostToolUse + Stop hook combination rather than modifying core agent loop directly, leveraging existing extension system for zero-token syntax/intent checks and minimal-token regression testing
- **[Memory Architecture]**: Extend existing memories system with knowledge extraction tier rather than replacing it, maintaining backward compatibility while adding cross-session learning
- **[Error Recovery]**: Build structured error parser pipeline that integrates with existing ToolError system and reliability extension, adding auto-retry capability for common error patterns

## BUGS FIXED
- None (enhancement only)

## NEXT
1. [Verification System] Implement automatic verify-after-edit loop using PostToolUse and Stop hooks
2. [Memory System] Add knowledge extraction and persistent learning layer to memories system
3. [Error Recovery] Build structured error parsing with auto-retry for compilation/test failures
4. [Integration] Wire all three systems to work together cohesively
5. [Validation] Test enhancements with real-world coding scenarios

## CRITICAL
- PLAN.md
- Source files to be modified:
  - packages/coding-agent/src/extensibility/extensions/reliability.ts
  - packages/coding-agent/src/memories/index.ts
  - packages/coding-agent/src/memories/storage.ts
  - packages/coding-agent/src/tools/tool-errors.ts
  - packages/coding-agent/src/prompts/system/system-prompt.md (for documentation)