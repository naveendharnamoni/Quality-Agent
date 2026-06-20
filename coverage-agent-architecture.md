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
15. [Future Enhancements](#future-enhancements)

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

**Output**
```json
{
  "coverage": 72.4,
  "branchCoverage": 68.9,
  "issueCount": 42
}
```

> **Note:** This is stored for reporting only. It is **not** used as the primary success condition. `targetCovered == true` on the specific Sonar line is the success condition — not a coverage delta. A positive delta could come from an unrelated line while the actual target remains uncovered.

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

Because the organisation has standardised test patterns across all projects, there is no need to scan the codebase at runtime. The framework, mocking library, assertion style, and naming convention are already known. This makes the output **deterministic** and eliminates the risk of the agent detecting the wrong framework from an edge-case file.

`test_pattern_analyze` is intentionally **not in the per-line loop**. It runs once here in setup and the resulting `PatternSpec` is injected into the loop's context for all subsequent iterations.

**Source:** `config.json` — bundled with the extension.

**Output (PatternSpec)**

See [Org Pattern Config](#org-pattern-config) section for the full config schema.

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

> **Why `maxRetries` lives in config:** Different language stacks have different complexity profiles. React component tests may need fewer retries than deeply-injected .NET service methods. Keeping this in config means it is adjustable per org and per language without touching extension code.

---

## Phase 2 — Coverage Resolution Loop

Executed **once for each Sonar issue** returned by `sonar_fetch`. The `PatternSpec` from Phase 1 is available throughout.

---

### Step 1 — `symbol_lookup`

Locates the target code element using Roslyn (for .NET) or the Language Server Protocol.

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

Builds the call graph for the target method. Determines what the method calls — and therefore what will need to be mocked in the test.

**Example output**
```
CreateOrder
 ├── ValidateOrder        → IOrderValidator
 ├── _repository.Save()  → IRepository
 └── _eventBus.Publish() → IEventBus
```

---

### Step 3 — `find_tests`

Locates existing tests related to the target. Provides the agent with real examples of how tests are written in this codebase — the most reliable pattern signal available.

**Search order**
1. Same method
2. Same class
3. Same service
4. Same feature area

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

> **This is the most critical setup step for test generation quality.** Missing or incorrectly mocked dependencies are the single most common reason AI-generated tests fail to compile or run.

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

Analyses **only the target method** — not the whole file. This is a key design decision: in large .NET solutions, loading a 1500-line file wastes context on irrelevant code.

**Extracts**
- Branch count and branch conditions
- Guard clauses and early returns
- Exception paths (`throw`, `catch`)
- Business rule checkpoints
- Which injected dependencies are actually used in this method

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

> **This is a native LLM action — not a tool call.** Keeping it as the agent's core action (rather than wrapping it in a tool) keeps the architecture clean and avoids the model calling itself indirectly.

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

> **Why structured failure output matters:** The `failureReason` field from `build_verify` is written directly into `coverage_memory` on the retry path. Without it, the memory entry only knows the attempt failed — not why. The retry loop then has no signal for choosing a different strategy.

---

### Step 9 — `target_coverage_verify`

Determines whether the **specific Sonar issue** was resolved — not whether overall coverage improved.

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

A coverage delta can be positive from an incidental line while the actual Sonar target remains uncovered. Checking the specific line eliminates false positives and ensures the original issue is genuinely resolved.

---

## Success Path

When `targetCovered == true`:

1. **`coverage_memory.write`** — mark `resolved: true`, clear `escalate`
2. **`git_diff`** — scoped to generated test files only (not the whole working tree)
3. **Optional: Sonar validation scan** — triggered only if developer selects "Validate with Sonar" at review time; not run by default, as it adds latency to the happy path
4. **Present changes to developer**

**Developer sees**
```diff
+ [Fact]
+ public async Task CreateOrder_Should_Throw_When_RepositoryFails()
+ {
+     // Arrange
+     _repository
+         .Setup(r => r.Save(It.IsAny<Order>()))
+         .ThrowsAsync(new RepositoryException("DB unavailable"));
+
+     // Act & Assert
+     await act.Should().ThrowAsync<RepositoryException>();
+ }
```

**Developer options**
- **Approve** → changes applied
- **Reject** → discarded; memory records the rejection
- **Modify** → developer edits inline before applying

**Changes are applied only after explicit approval.**

---

## Retry Path

When `targetCovered == false`:

1. **`coverage_memory.write`** — update the memory record:

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
   - `true` → loop back to `target_code_analyze` with updated memory context; agent selects a strategy not in `strategiesAttempted[]`
   - `false` → escalate (see below)

**Agent retry visibility in chat**

The agent surfaces retry state in the chat UI so the developer is always informed:

```
[Attempt 2/3] — Previous strategy (mock_throw) failed:
"Dependency throws before reaching target branch"
Trying: cache_miss scenario
```

This transparency is especially important for getting enterprise team buy-in — the agent should never appear to be silently spinning.

---

## Escalation

When `attemptCount >= maxRetries`:

```json
{
  "escalate": true,
  "resolved": false
}
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

**Agent stops retrying this line.** It moves to the next issue in the queue.

---

## Coverage Memory

Persisted per line. Read before generation, written after every attempt (success or failure).

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
| `failureReason` | `string` | From `build_verify` failure output — why the last attempt failed |
| `strategiesAttempted[]` | `string[]` | Agent must pick a strategy not in this list |
| `resolved` | `bool` | Set `true` on success path; ensures line is never retried |
| `escalate` | `bool` | Set `true` when `attemptCount >= maxRetries`; skips line in all future runs |

---

## Org Pattern Config

Bundled with the extension as `config.json`. **One entry per supported language.**

No scanning. No inference. `test_pattern_lookup` is a key lookup against this file using the `projectType` from `file_type_detect`.

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

**Why `maxRetries` is per language:** React component tests have fewer dependency injection complexities than deeply-injected .NET services. Keeping `maxRetries` in config lets the org tune it per stack without touching extension code.

**Why `naming` matters:** The `naming` field is injected verbatim into the LLM prompt. Generated test names will match org convention exactly — indistinguishable from human-written tests. This is the field code reviewers notice most.

---

## Tool Registry

### External Systems
| Tool | Purpose |
|---|---|
| `sonar_fetch` | Pull coverage issues from SonarQube API |
| `build_verify` | Build project and run test suite with coverage collection |
| `git_diff` | Generate diff scoped to generated test files only |

### IDE / LSP
| Tool | Purpose |
|---|---|
| `file_type_detect` | Map file extension to project type |
| `symbol_lookup` | Resolve target symbol via Roslyn / LSP |
| `find_references` | Build call graph for mocking requirements |
| `find_tests` | Locate existing tests for the target class/method |

### Analysis
| Tool | Purpose |
|---|---|
| `coverage_baseline` | Capture pre-modification metrics for reporting |
| `dependency_graph_analyze` | Extract constructor dependencies and mock names |
| `target_code_analyze` | Analyse target method — branches, guards, exceptions |
| `target_coverage_verify` | Confirm the specific Sonar line is now covered |

### Configuration
| Tool | Purpose |
|---|---|
| `test_pattern_lookup` | Load org pattern spec from static `config.json` |

### Memory
| Tool | Purpose |
|---|---|
| `coverage_memory.read` | Load attempt history before generation |
| `coverage_memory.write` | Persist attempt result after build_verify |

### Native Agent Action
| Action | Purpose |
|---|---|
| `generate_test` | LLM writes the test — not a tool call |

---

## `build_verify` Failure Schema

The failure output from `build_verify` is the primary signal for `coverage_memory.write` on the retry path. It must be structured — not just a boolean.

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

Common `failureReason` values the agent uses to switch strategy:

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

## Future Enhancements

### Phase 2 — `@sonar.fix`

Extend the agent to address non-coverage Sonar issues:

- Fix code smells
- Fix security vulnerabilities
- Fix security hotspots

Same tool architecture, different Sonar issue types as input.

### Phase 3 — MCP Server Integration

Expose the agent's toolchain as an MCP server:

```
MCP Server
 ├── SonarQube API tools
 ├── Roslyn analysis tools
 ├── Build pipeline tools
 ├── Coverage report tools
 └── Git operation tools
```

**Why this matters:** Copilot Chat, future AI agents, and CI pipelines can all reuse the same toolchain without rewriting VS Code extension logic. The `@coverage` extension becomes one consumer of the MCP server — not the only one.

---

*@coverage · VS Code Chat Participant · Built for .NET · Angular · React · SonarQube*
