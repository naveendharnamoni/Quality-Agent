# @coverage Agent — Architecture & Design Specification

> VS Code Chat Participant · .NET · Angular · React · SonarQube

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [High-Level Architecture](#high-level-architecture)
4. [Phase 1 — Setup](#phase-1--setup)
5. [Phase 2 — Coverage Resolution Loop](#phase-2--coverage-resolution-loop)
6. [Decision Node](#decision-node)
7. [Success Path](#success-path)
8. [Retry Path](#retry-path)
9. [Escalation](#escalation)
10. [Coverage Memory](#coverage-memory)
11. [Org Pattern Config](#org-pattern-config)
12. [Tool Registry](#tool-registry)
13. [build_verify Failure Schema](#build_verify-failure-schema)
14. [Success Metrics](#success-metrics)
15. [Implementation Changes](#implementation-changes)
16. [Future Enhancements](#future-enhancements)

---

## Overview

The `@coverage` agent is a VS Code Chat Participant that resolves SonarQube coverage gaps by generating targeted, organisation-compliant unit tests.

**The primary objective is not to maximise overall coverage percentage.**
The goal is to resolve specific SonarQube coverage issues while maintaining build stability and test quality that matches existing organisational standards.

The agent is **human-in-the-loop by design**. Generated tests are never applied automatically. Every change requires explicit developer approval before it is written to disk.

---

## Design Principles

| Principle | Rationale |
|---|---|
| Target-specific coverage | Resolving a Sonar issue is the success condition — not a coverage delta |
| Human approval before apply | Protects quality gates; prevents trivially passing but meaningless tests |
| Static pattern config | Org-wide standards are known upfront — no runtime discovery needed |
| Symbol-level context | Large .NET files are not loaded in full — only the target method and its dependencies |
| Memory-backed retries | Prevents the agent from repeating the same failing strategy in a loop |
| Structured build output | Pass/fail is not enough — the retry loop needs actionable failure detail |
| Explicit escalation | Untestable candidates are surfaced to humans, not looped indefinitely |
| Delegate to platform | Use VS Code built-in tools and official MCP servers instead of reimplementing them |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                   PHASE 1 — SETUP                   │
│              (runs once per invocation)              │
│                                                     │
│  sonar_fetch → coverage_baseline → file_type_detect │
│                      → test_pattern_lookup           │
└─────────────────────┬───────────────────────────────┘
                      │ PatternSpec injected into loop context
                      ▼
┌─────────────────────────────────────────────────────┐
│           PHASE 2 — PER-LINE RETRY LOOP             │
│            (runs for each Sonar issue)              │
│                                                     │
│  symbol_lookup → find_references → find_tests       │
│    → dependency_graph_analyze → target_code_analyze │
│    → coverage_memory.read → [LLM generate_test]     │
│    → build_verify → target_coverage_verify          │
│                      │                              │
│              ┌───────┴────────┐                     │
│         targetCovered?        │                     │
│           YES      NO         │                     │
│            │        │         │                     │
│            ▼        ▼         │                     │
│      Human     memory.write   │                     │
│      Review    + retry/       │                     │
│        │       escalate       │                     │
│        ▼                      │                     │
│     Apply ◄───────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

---

## Phase 1 — Setup

Runs **once** per agent invocation. Establishes all context that is constant across every line in the loop.

---

### 1. `sonar_fetch`

Retrieves all SonarQube coverage targets for the selected project and branch.

> **Implementation:** Delegates to the official **SonarQube MCP server** (`sonarsource/sonarqube-mcp`) via `search_issues` tool. Supports self-hosted SonarQube via `SONARQUBE_URL` + `SONARQUBE_TOKEN`. No raw REST calls needed.

**Input**
```json
{
  "projectKey": "order-api",
  "branch": "develop"
}
```

**Output**
```json
{
  "issues": [
    { "file": "OrderService.cs", "line": 145, "type": "coverage" },
    { "file": "OrderService.cs", "line": 198, "type": "branch_coverage" },
    { "file": "PaymentService.cs", "line": 87, "type": "coverage" }
  ]
}
```

**Responsibilities**
- Retrieve uncovered lines
- Retrieve branch coverage gaps
- Retrieve vulnerabilities flagged as coverage-related
- Return a prioritised issue list for the loop

---

### 2. `coverage_baseline`

Captures coverage metrics **before** any modifications. Stored as the reference point — every subsequent delta is measured against this.

> **Implementation:** Delegates to SonarQube MCP server `get_measures` tool.

**Output**
```json
{
  "coverage": 72.4,
  "branchCoverage": 68.9,
  "issueCount": 42
}
```

> **Note:** Stored for reporting only. **Not** used as the primary success condition. `targetCovered == true` on the specific Sonar line is the success condition. A positive delta could come from an unrelated line while the actual target remains uncovered.

---

### 3. `file_type_detect`

Identifies the project technology stack from file extension. Runs once — output feeds directly into `test_pattern_lookup`.

**Mapping**

| Extension / Workspace | Project Type |
|---|---|
| `.cs` | `dotnet` |
| `.ts` or `.html` in Angular workspace | `angular` |
| `.tsx` or `.jsx` | `react` |

**Output**
```json
{
  "projectType": "dotnet"
}
```

---

### 4. `test_pattern_lookup`

Loads the organisation-specific testing standards from a bundled static config.

**This is a config lookup — not a discovery tool.**

Because the organisation has standardised test patterns across all projects, there is no need to scan the codebase at runtime. The framework, mocking library, assertion style, and naming convention are already known. This makes the output **deterministic** and eliminates the risk of the agent detecting the wrong framework.

Runs **once in Phase 1**. The resulting `PatternSpec` is injected into the loop context for all subsequent iterations — never re-run per line.

**Source:** `config.json` — bundled with the extension.

```json
{
  "framework": "xUnit",
  "mocking": "Moq",
  "assertion": "FluentAssertions",
  "pattern": "AAA",
  "naming": "{Method}_Should_{Behavior}_When_{Condition}",
  "baseClass": "BaseApiTest",
  "fixtures": ["WebApplicationFactory", "InMemoryDb"],
  "maxRetries": 3
}
```

> **Why `maxRetries` lives in config:** React component tests have fewer injection complexities than deeply-injected .NET services. Keeping it in config makes it adjustable per language without touching extension code.

---

## Phase 2 — Coverage Resolution Loop

Executed **once for each Sonar issue** returned by `sonar_fetch`. The `PatternSpec` from Phase 1 is available throughout.

---

### Step 1 — `symbol_lookup`

Locates the target code element using VS Code's built-in `executeDefinitionProvider` + `executeDocumentSymbolProvider`.

> **Implementation:** Uses `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider')` for accurate class + method extraction from the LSP symbol tree, with text-parsing fallback.

**Output**
```json
{
  "class": "OrderService",
  "method": "CreateOrder",
  "file": "OrderService.cs",
  "line": 145
}
```

---

### Step 2 — `find_references`

Builds the call graph for the target method. Determines what the method calls — and therefore what will need to be mocked.

> **Implementation:** Uses VS Code Call Hierarchy API — `prepareCallHierarchy` + `provideIncomingCalls`. This is purpose-built for call graphs and returns structured `CallHierarchyIncomingCall` objects instead of raw `Location[]`. Gives callerClass, callerMethod, and interface — exactly what the LLM needs to determine what to mock.

**Example output**
```
CreateOrder
 ├── ValidateOrder        → IOrderValidator
 ├── _repository.Save()  → IRepository
 └── _eventBus.Publish() → IEventBus
```

---

### Step 3 — `find_tests`

Locates existing tests related to the target. Provides the agent with real examples of how tests are written — the most reliable pattern signal available.

> **Implementation:** Uses VS Code built-in `vscode.workspace.findFiles` (same mechanism as Copilot `#search/fileSearch`) for file discovery. Test name extraction via regex for both `.NET` (`[Fact]`/`[Theory]`) and JS/TS (`it()`/`test()`).

**Search order**
1. Same method
2. Same class
3. Same class (spec)
4. Any test file

**Output**
```json
{
  "testFiles": ["OrderServiceTests.cs"],
  "existingTests": ["CreateOrder_Should_Return_Order_When_Valid"]
}
```

---

### Step 4 — `dependency_graph_analyze`

Determines the constructor-level dependencies of the target class.

> **This is the most critical setup step for test generation quality.** Missing or incorrectly mocked dependencies are the single most common reason AI-generated tests fail to compile or run. No built-in VS Code tool or MCP server covers this — it is custom-built.

**Example**
```
OrderService constructor
 ├── IRepository<Order>
 ├── IMapper
 ├── ICache
 └── ILogger<OrderService>
```

**Output**
```json
{
  "dependencies": [
    { "interface": "IRepository<Order>", "mockName": "_repository" },
    { "interface": "IMapper",            "mockName": "_mapper"     },
    { "interface": "ICache",             "mockName": "_cache"      },
    { "interface": "ILogger<OrderService>", "mockName": "_logger"  }
  ]
}
```

The `mockName` field is the field name in the class — the agent uses this to wire up `Mock<T>` instances with the correct variable names, matching the existing test style.

---

### Step 5 — `target_code_analyze`

Analyses **only the target method** — not the whole file. In large .NET solutions, loading a 1500-line file wastes context on irrelevant code.

> **No built-in replacement exists for this tool.** It is custom-built and walks the method body brace-by-brace to extract only what is needed.

**Extracts**
- Branch count and branch conditions
- Guard clauses and early returns
- Exception paths (`throw`, `catch`)
- Business rule checkpoints
- Which injected dependencies are actually called in this method

**Output**
```json
{
  "method": "CreateOrder",
  "branches": 4,
  "exceptions": 2,
  "guards": ["if (order == null) throw ArgumentNullException"],
  "targetLine": 145,
  "dependenciesUsed": ["IRepository", "IEventBus"]
}
```

---

### Step 6 — `coverage_memory.read`

Checks whether this specific line has been attempted before. If yes, loads the failure history so the agent can pick a different strategy.

**Output (if previously attempted)**
```json
{
  "file": "OrderService.cs",
  "line": 145,
  "attempted": true,
  "attemptCount": 2,
  "strategiesAttempted": ["mock_throw", "null_input"],
  "failureReason": "Dependency throws before reaching target branch",
  "escalate": false
}
```

**Rule:** The agent must never select a strategy already present in `strategiesAttempted[]`.

---

### Step 7 — `generate_test` (LLM native action)

The agent generates the next candidate test.

> **This is a native LLM action — not a tool call.** Keeping it as the agent's core action keeps the architecture clean and avoids the model calling itself indirectly.

**Inputs available at generation time**
- `PatternSpec` — from Phase 1 static config (framework, mocking lib, naming convention)
- `find_tests` output — real examples from the codebase
- `dependency_graph_analyze` output — what to mock and how
- `target_code_analyze` output — what branches/exceptions need hitting
- `coverage_memory` — failure history and strategies already tried
- `sonar_fetch` issue — the exact line that must be covered

**Example strategy progression across retries**

| Attempt | Strategy | Target |
|---|---|---|
| 1 | Null input validation | Guard clause at line 145 |
| 2 | Repository exception | `catch` block after `_repository.Save()` |
| 3 | Cache miss scenario | Branch when `_cache.Get()` returns null |

**Example generated test (.NET)**
```csharp
[Fact]
public async Task CreateOrder_Should_Throw_When_RepositoryFails()
{
    // Arrange
    var order = new OrderBuilder().Valid().Build();
    _repository
        .Setup(r => r.Save(It.IsAny<Order>()))
        .ThrowsAsync(new RepositoryException("DB unavailable"));

    // Act
    var act = async () => await _sut.CreateOrder(order);

    // Assert
    await act.Should().ThrowAsync<RepositoryException>();
}
```

The generated test name matches the org naming convention from `PatternSpec`:
`{Method}_Should_{Behavior}_When_{Condition}` → `CreateOrder_Should_Throw_When_RepositoryFails`

---

### Step 8 — `build_verify`

Builds the project and runs the test suite. Returns structured output — not just pass/fail.

> **Implementation:** Delegates to VS Code built-in Copilot tools `#execute/runInTerminal` + `#execute/getTerminalOutput` + `#execute/testFailure`. No `child_process.exec` needed.

**Commands (.NET)**
```bash
dotnet build
dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=json
```

**Success output**
```json
{
  "buildSuccess": true,
  "testsPassed": 451,
  "testsFailed": 0,
  "coverageFile": "coverage.json"
}
```

**Failure output**
```json
{
  "buildSuccess": false,
  "testsPassed": 0,
  "testsFailed": 1,
  "error": "CS0246: The type or namespace 'IOrderValidator' could not be found",
  "failureReason": "Missing using directive for mocked dependency",
  "coverageFile": null
}
```

> **Why structured failure output matters:** The `failureReason` field is written directly into `coverage_memory` on the retry path. Without it, the memory entry only knows the attempt failed — not why. The retry loop has no signal for choosing a different strategy.

---

### Step 9 — `target_coverage_verify`

Determines whether the **specific Sonar line** was resolved — not whether overall coverage improved.

> **No built-in replacement.** Parses Coverlet/Istanbul JSON to check hit count on the exact line number. Custom-built.

**Before**
```json
{ "file": "OrderService.cs", "line": 145, "covered": false }
```

**After**
```json
{ "file": "OrderService.cs", "line": 145, "covered": true }
```

**Output**
```json
{
  "targetCovered": true,
  "newlyCoveredLines": [145],
  "remainingLines": []
}
```

---

## Decision Node

```
targetCovered == true?
        │
   ┌────┴─────┐
  YES         NO
   │           │
   ▼           ▼
Success      Retry
 Path         Path
```

**Success condition:** `targetCovered == true`
**Not:** `coverageDelta > 0`

A coverage delta can be positive from an incidental line while the actual Sonar target remains uncovered. Checking the specific line eliminates false positives.

---

## Success Path

When `targetCovered == true`:

1. **`coverage_memory.write`** — mark `resolved: true`, clear `escalate`
2. **`git_diff`** — via Copilot built-in `#search/changes`, scoped to generated test files only
3. **Optional: Sonar validation scan** — only if developer selects "Validate with Sonar"; not run by default
4. **Present diff for human review**

**Developer options**
- **Approve** → `#edit/editFiles` or `#edit/createFile` applies the change
- **Reject** → discarded; memory records the rejection
- **Modify** → developer edits inline before applying

**Changes are applied only after explicit approval.**

---

## Retry Path

When `targetCovered == false`:

1. **`coverage_memory.write`** — log `failureReason`, increment `attemptCount`, append strategy

```json
{
  "attemptCount": 3,
  "strategiesAttempted": ["mock_throw", "null_input", "cache_miss"],
  "failureReason": "Branch not reached — cache mock returns value before target line",
  "resolved": false,
  "escalate": false
}
```

2. **Check `attemptCount < maxRetries`**
   - `true` → loop back to `target_code_analyze` with updated memory; agent picks a strategy not in `strategiesAttempted[]`
   - `false` → escalate

**Agent retry visibility in chat**

```
[Attempt 2/3] — Previous strategy (mock_throw) failed:
"Dependency throws before reaching target branch"
Trying: cache_miss scenario
```

---

## Escalation

When `attemptCount >= maxRetries`:

```json
{ "escalate": true, "resolved": false }
```

**Surfaced to developer as:**

```
⚠ Line 145 — OrderService.cs
Could not generate a passing test after 3 attempts.

Possible reasons:
  • Dead code — line is unreachable in practice
  • Untestable path — requires external system state
  • External dependency limitation — cannot be mocked at this boundary
  • Incorrect Sonar target — generated or platform code
  • Generated test limitation — beyond current agent capability

Recommended action: Review manually or suppress Sonar issue with justification.
```

**Agent stops retrying this line** and moves to the next issue in the queue.

---

## Coverage Memory

Persisted per line using `vscode.ExtensionContext.globalState`. Read before generation, written after every attempt.

**Full schema**
```json
{
  "file": "OrderService.cs",
  "line": 145,
  "attempted": true,
  "attemptCount": 2,
  "failureReason": "Dependency throws before reaching target branch",
  "strategiesAttempted": [
    "mock_throw",
    "null_dependency"
  ],
  "resolved": false,
  "escalate": false
}
```

**Field reference**

| Field | Type | Purpose |
|---|---|---|
| `attempted` | `bool` | Has this line been tried before |
| `attemptCount` | `int` | Current retry count |
| `failureReason` | `string` | From `build_verify` — why the last attempt failed |
| `strategiesAttempted[]` | `string[]` | Agent must pick a strategy not in this list |
| `resolved` | `bool` | Set `true` on success; line never retried |
| `escalate` | `bool` | Set `true` when `attemptCount >= maxRetries`; skipped in future runs |

---

## Org Pattern Config

Bundled with the extension as `config.json`. **One entry per supported language.**

No scanning. No inference. `test_pattern_lookup` is a key lookup using the `projectType` from `file_type_detect`.

```json
{
  "dotnet": {
    "framework": "xUnit",
    "mocking": "Moq",
    "assertion": "FluentAssertions",
    "pattern": "AAA",
    "naming": "{Method}_Should_{Behavior}_When_{Condition}",
    "baseClass": "BaseApiTest",
    "fixtures": ["WebApplicationFactory", "InMemoryDb"],
    "maxRetries": 3
  },
  "angular": {
    "framework": "Jasmine",
    "runner": "Karma",
    "mocking": "SpyObj",
    "pattern": "AAA",
    "naming": "should {behavior} when {condition}",
    "utilities": ["TestBed", "HttpClientTestingModule", "RouterTestingModule"],
    "maxRetries": 3
  },
  "react": {
    "framework": "Jest",
    "library": "React Testing Library",
    "mocking": "jest.mock",
    "pattern": "AAA",
    "naming": "{Component} - should {behavior} when {condition}",
    "utilities": ["render", "screen", "userEvent", "MSW"],
    "maxRetries": 3
  }
}
```

**Why `naming` matters:** The `naming` field is injected verbatim into the LLM prompt. Generated test names match org convention exactly — indistinguishable from human-written tests.

---

## Tool Registry

### External Systems — via SonarQube MCP Server
| Tool | MCP Tool Used | Purpose |
|---|---|---|
| `sonar_fetch` | `search_issues` | Pull coverage issues from self-hosted SonarQube |
| `coverage_baseline` | `get_measures` | Capture pre-modification metrics |

### Build & Apply — via Copilot Built-in Tools
| Tool | Copilot Tool Used | Purpose |
|---|---|---|
| `build_verify` | `#execute/runInTerminal` + `#execute/getTerminalOutput` + `#execute/testFailure` | Run build + tests, get structured output |
| `git_diff` | `#search/changes` | Diff scoped to generated test files |
| Apply test | `#edit/editFiles` / `#edit/createFile` | Write approved test to disk |

### IDE / LSP — via VS Code Built-in Commands
| Tool | VS Code API Used | Purpose |
|---|---|---|
| `symbol_lookup` | `executeDefinitionProvider` + `executeDocumentSymbolProvider` | Resolve target class and method |
| `find_references` | `prepareCallHierarchy` + `provideIncomingCalls` | Build structured call graph for mocking |
| `find_tests` | `workspace.findFiles` | Locate existing tests by search order |

### Custom Built — No Existing Equivalent
| Tool | Purpose |
|---|---|
| `dependency_graph_analyze` | Constructor parameter extraction + mock name resolution |
| `target_code_analyze` | Method body extraction — branches, guards, exceptions, dep usage |
| `target_coverage_verify` | Parse Coverlet/Istanbul JSON to confirm specific line is hit |
| `coverage_memory.read/write` | Per-line attempt history — prevents strategy repetition |
| `test_pattern_lookup` | Static org config key lookup |
| `generate_test` | LLM native action — not a tool call |

---

## `build_verify` Failure Schema

The failure output from `build_verify` feeds directly into `coverage_memory.write` on the retry path. Must be structured — not just a boolean.

```json
{
  "buildSuccess": false,
  "testsPassed": 0,
  "testsFailed": 1,
  "error": "CS0246: The type or namespace 'IOrderValidator' could not be found",
  "failureReason": "Missing using directive for mocked dependency",
  "coverageFile": null
}
```

Common `failureReason` values and next strategy:

| Reason | Next strategy |
|---|---|
| `"Missing using directive"` | Add correct namespace imports |
| `"Dependency throws before target branch"` | Mock dependency to succeed; hit branch differently |
| `"Branch not reached"` | Change input to exercise the specific condition |
| `"Null reference in constructor setup"` | Review dependency graph — missing mock setup |
| `"Test passes but line not covered"` | Assertion passes trivially — restructure act phase |

---

## Success Metrics

### Primary
- Sonar issue resolved (`targetCovered == true`)

### Secondary
- Build remains stable (zero regressions)
- New test passes consistently
- Coverage percentage increases
- Branch coverage increases

### Tertiary
- Reduced manual effort for developers
- Faster Sonar quality gate compliance
- Escalated lines documented for manual review

---

## Implementation Changes

This section documents every decision made during design and development that changes what is built, replaced, or dropped compared to the initial approach.

---

### IC-01 — SonarQube MCP Server replaces raw REST calls

**What changed:** `sonarTools.ts` no longer makes raw `fetch()` calls to the SonarQube REST API.

**Old approach**
```typescript
const res = await fetch(`${sonarUrl}/api/issues/search?...`, {
  headers: { Authorization: `Bearer ${sonarToken}` },
});
```

**New approach**
```typescript
// Delegates to official SonarQube MCP server (sonarsource/sonarqube-mcp)
const data = await callSonarMcp('search_issues', { projectKey, branch });
```

**Why:** The official MCP server handles authentication, rate limiting, pagination, and API versioning. It supports self-hosted SonarQube via `SONARQUBE_URL` + `SONARQUBE_TOKEN` environment variables — pointing at your org's server requires only setting those two values.

**MCP tools used**
| sonarTools.ts function | MCP tool |
|---|---|
| `sonarFetch` | `search_issues` |
| `coverageBaseline` | `get_measures` |

**MCP server config**
```bash
SONARQUBE_URL=https://sonar.yourorg.com
SONARQUBE_TOKEN=your-token-here
```

---

### IC-02 — Call Hierarchy API replaces executeReferenceProvider

**What changed:** `find_references` in `ideTools.ts` now uses `prepareCallHierarchy` + `provideIncomingCalls` instead of `vscode.executeReferenceProvider`.

**Old approach**
```typescript
const refs = await vscode.commands.executeCommand<vscode.Location[]>(
  'vscode.executeReferenceProvider', uri, position,
);
// Returns raw Location[] — needs manual parsing to get caller class/method
```

**New approach**
```typescript
const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
  'vscode.prepareCallHierarchy', uri, position,
);
const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
  'vscode.provideIncomingCalls', items[0],
);
// Returns structured CallHierarchyIncomingCall — callerClass, callerMethod, interface
```

**Why:** The Call Hierarchy API is purpose-built for "who calls this method" questions. It returns `CallerInfo` objects with class name, method name, and interface — directly what the LLM needs to determine what to mock. The old `Location[]` approach required fragile text parsing to extract the same information.

**New type added to `types.ts`**
```typescript
export interface CallerInfo {
  callerClass:  string;
  callerMethod: string;
  interface:    string;
}
```

---

### IC-03 — DocumentSymbolProvider replaces regex for symbol_lookup

**What changed:** `symbol_lookup` in `ideTools.ts` now uses `executeDocumentSymbolProvider` to extract class and method names from the LSP symbol tree, with text-parsing as fallback only.

**Old approach**
```typescript
const text        = doc.lineAt(def.range.start.line).text.trim();
const methodMatch = text.match(/(?:async\s+)?[\w<>]+\s+(\w+)\s*\(/);
const classMatch  = doc.getText().match(/class\s+(\w+)/);
```

**New approach**
```typescript
const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
  'vscode.executeDocumentSymbolProvider', def.uri,
);
// Walk symbol tree: Class → child symbol that contains target position → method name
```

**Why:** Regex on raw text breaks on generic methods, partial classes, attributes, and multiline signatures. The LSP symbol tree is accurate regardless of code style.

---

### IC-04 — Copilot built-in tools replace child_process for build_verify

**What changed:** `build_verify` in `buildTools.ts` no longer uses Node's `child_process.exec`. It delegates to Copilot's built-in terminal tools.

**Old approach**
```typescript
import * as cp from 'child_process';
cp.exec('dotnet test /p:CollectCoverage=true', { cwd: workspaceRoot }, callback);
```

**New approach**
```typescript
// Delegates to VS Code Copilot built-in tools:
// #execute/runInTerminal    — runs the command
// #execute/getTerminalOutput — gets structured stdout/stderr
// #execute/testFailure      — gets structured test failure detail
```

**Why:** Copilot's terminal tools handle output streaming, VS Code task integration, and structured test failure parsing. `#execute/testFailure` returns typed test failure objects — no regex parsing of stdout needed.

---

### IC-05 — Copilot built-in tools replace manual file apply

**What changed:** `applyGeneratedTest` in `extension.ts` no longer uses `fs.writeFile` / `fs.readFile` to apply test files to disk.

**Old approach**
```typescript
import * as fs from 'fs/promises';
await fs.writeFile(filePath, updated, 'utf-8');
```

**New approach**
```typescript
// Delegates to Copilot built-in edit tools:
// #edit/createFile — when test file doesn't exist yet
// #edit/editFiles  — when appending to existing test class
```

**Why:** Copilot's edit tools handle file creation, diff preview, and undo history natively within VS Code. The developer sees the same diff view they'd see for any other Copilot suggestion.

---

### IC-06 — Copilot #search/changes replaces git shell call for git_diff

**What changed:** `git_diff` no longer shells out to `git diff`.

**Old approach**
```typescript
cp.exec('git diff --name-only HEAD', ...);
```

**New approach**
```typescript
// Delegates to Copilot built-in: #search/changes
// Scoped to generated test files only
```

**Why:** `#search/changes` integrates with VS Code's source control model directly and respects any SCM provider (Git, Azure Repos, etc.) without assuming `git` is on PATH.

---

### IC-07 — LangChain / LangGraph explicitly ruled out

**Decision:** No orchestration framework is used. The retry loop is plain TypeScript.

**Rationale:**
- LangChain/LangGraph are Python-first. The extension must be TypeScript.
- The agent has one loop with one decision node — a `while` loop is the correct abstraction.
- Adding a framework adds a heavyweight dependency for zero architectural benefit.

```typescript
// The entire "orchestration" is this
while (!targetCovered && attemptCount < maxRetries) {
  const memory      = await coverageMemory.read(file, line);
  const codeAnalysis = await targetCodeAnalyze(symbol);
  const generated   = await generateTest({ ...context, memory, codeAnalysis });
  const buildResult = await buildVerify(workspaceRoot, projectType);
  targetCovered     = (await targetCoverageVerify(file, line, buildResult)).targetCovered;
  await coverageMemory.writeFailure(file, line, generated.strategy, buildResult);
  attemptCount++;
}
```

---

### IC-08 — test_pattern_analyze removed from retry loop

**Decision:** `test_pattern_analyze` runs **once in Phase 1** as a static config lookup. It does not re-run per line or per retry.

**Why:** The organisation has standardised test patterns across .NET, Angular, and React. There is nothing to discover at runtime. Running it per iteration would re-detect the same result on every pass and waste tokens.

**Consequence:** `sonarTools.ts` was removed entirely in v2. `test_pattern_lookup` in `patternConfig.ts` is a pure key lookup against `ORG_CONFIG` — no file I/O, no scanning.

---

### IC-09 — sonarTools.ts removed as a standalone file

**Decision:** `sonarTools.ts` is retained in the project but its implementation now wraps MCP calls only. The file exists to maintain a clean tool boundary — if the MCP server API changes, only this file needs updating.

**Note for SonarQube self-hosted setup:** The MCP server must be configured with your org's server details before the extension will work. See IC-01 for the required environment variables.

---

### IC-10 — File structure flattened from types/index.ts to types.ts

**Decision:** The nested `src/types/index.ts` was replaced with a flat `src/types.ts`.

**Why:** `types/index.ts` contained one file — there was nothing to barrel. The `index.ts` convention is only useful when a folder contains multiple files that need a single re-export point. A single types file at `src/types.ts` is simpler and imports are identical:
```typescript
import { SonarIssue, PatternSpec } from '../types'; // unchanged either way
```

---

## Future Enhancements

### Phase 2 — `@sonar.fix`

Extend the agent to address non-coverage Sonar issues:
- Fix code smells
- Fix security vulnerabilities
- Fix security hotspots

Same tool architecture, different Sonar issue types as input.

### Phase 3 — MCP Server Integration

Expose the agent's toolchain as a standalone MCP server:

```
MCP Server
 ├── SonarQube API tools     (via sonarsource/sonarqube-mcp passthrough)
 ├── Roslyn analysis tools   (dependency_graph_analyze, target_code_analyze)
 ├── Build pipeline tools    (build_verify, target_coverage_verify)
 ├── Coverage memory tools   (read, write)
 └── Git operation tools     (git_diff)
```

Copilot Chat, CI pipelines, and future AI agents can all reuse the same toolchain without rewriting VS Code extension logic.

---

*@coverage · VS Code Chat Participant · Built for .NET · Angular · React · SonarQube*
