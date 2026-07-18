# @coverage Agent Architecture

## Overview

The `@coverage` agent is a VS Code Chat Participant designed to improve SonarQube coverage gaps by generating targeted unit tests.

Unlike traditional code-generation agents, the goal is not to maximize overall coverage percentage. The primary objective is to resolve specific SonarQube coverage issues while maintaining build stability and test quality.

The agent operates in two phases:

1. **Setup Phase** (runs once)
2. **Coverage Resolution Loop** (runs for each Sonar issue)

The workflow is human-in-the-loop. Generated tests are never applied automatically.

---

# High-Level Architecture

```text
┌────────────────────┐
│ SonarQube          │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ sonar_fetch        │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Setup Phase        │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Process Each Issue │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Retry Loop         │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Target Covered?    │
└──────┬───────┬─────┘
       │       │
      YES      NO
       │       │
       ▼       ▼
 Human Review Retry
       │
       ▼
 Apply Changes
```

---

# Phase 1 - Setup

Runs once per agent invocation.

---

## 1. sonar_fetch

### Purpose

Retrieve all SonarQube coverage targets for the selected project.

### Input

```json
{
  "projectKey": "order-api",
  "branch": "develop"
}
```

### Output

```json
{
  "issues": [
    {
      "file": "OrderService.cs",
      "line": 145,
      "type": "coverage"
    }
  ]
}
```

### Responsibilities

* Retrieve uncovered lines
* Retrieve branch coverage gaps
* Retrieve vulnerabilities
* Retrieve code smells
* Prioritize issues

---

## 2. coverage_baseline

### Purpose

Capture baseline metrics before any modifications.

### Output

```json
{
  "coverage": 72.4,
  "branchCoverage": 68.9,
  "issueCount": 42
}
```

### Usage

Stored for reporting and comparison.

Not used as the primary success criteria.

---

## 3. file_type_detect

### Purpose

Identify project technology stack.

### Mapping

| Extension               | Type    |
| ----------------------- | ------- |
| .cs                     | dotnet  |
| .ts + Angular Workspace | angular |
| .tsx                    | react   |
| .jsx                    | react   |

### Output

```json
{
  "projectType": "dotnet"
}
```

---

## 4. test_pattern_lookup

### Purpose

Load organization-specific testing standards.

### Source

```text
config.json
```

### Example

```json
{
  "framework": "xUnit",
  "mocking": "Moq",
  "assertion": "FluentAssertions",
  "pattern": "AAA",
  "naming": "{Method}_Should_{Behavior}_When_{Condition}"
}
```

### Why

Avoids expensive test-pattern discovery.

Provides deterministic outputs.

---

# Phase 2 - Coverage Resolution Loop

Executed once for each Sonar coverage target.

---

# Step 1 - symbol_lookup

### Purpose

Locate target code element.

### Output

```json
{
  "class": "OrderService",
  "method": "CreateOrder"
}
```

### Uses

* Roslyn
* Language Server Protocol (LSP)

---

# Step 2 - find_references

### Purpose

Build call graph.

### Example

```text
CreateOrder
 ├── ValidateOrder
 ├── SaveOrder
 └── PublishEvent
```

### Usage

Helps determine mocking requirements.

---

# Step 3 - find_tests

### Purpose

Locate nearby tests.

### Search Order

1. Same method
2. Same class
3. Same service
4. Same feature area

### Output

```json
{
  "testFiles": [
    "OrderServiceTests.cs"
  ]
}
```

---

# Step 4 - dependency_graph_analyze

### Purpose

Determine constructor dependencies.

### Example

```text
OrderService
├── IRepository
├── IMapper
├── ICache
└── ILogger<OrderService>
```

### Output

```json
{
  "dependencies": [
    "IRepository",
    "IMapper",
    "ICache",
    "ILogger"
  ]
}
```

### Why

Missing dependency setup is the most common cause of failed AI-generated tests.

---

# Step 5 - target_code_analyze

### Purpose

Analyze only the target method.

Avoid loading entire files.

### Extract

* Branches
* Conditions
* Guard clauses
* Exception paths
* Business rules
* Dependency usage

### Output

```json
{
  "method": "CreateOrder",
  "branches": 4,
  "exceptions": 2,
  "targetLine": 145
}
```

---

# Step 6 - coverage_memory.read

### Purpose

Prevent repetitive failures.

### Example

```json
{
  "line": 145,
  "attemptCount": 2,
  "strategiesAttempted": [
    "mock_throw",
    "null_input"
  ],
  "failureReason": "Dependency throws before target branch"
}
```

### Rules

Agent must not retry identical strategies.

---

# Step 7 - generate_test

### Purpose

Generate next candidate test.

### Inputs

* PatternSpec
* Existing tests
* Dependency graph
* Coverage memory
* Target method
* Sonar issue

### Example Strategy

Attempt 1

```text
Null input validation
```

Attempt 2

```text
Repository exception
```

Attempt 3

```text
Cache miss scenario
```

---

# Step 8 - build_verify

### Purpose

Validate generated test.

### Commands

```bash
dotnet build
dotnet test
```

### Coverage Collection

```bash
dotnet test \
  /p:CollectCoverage=true \
  /p:CoverletOutputFormat=json
```

### Output

```json
{
  "buildSuccess": true,
  "testsPassed": 450,
  "testsFailed": 0
}
```

---

# Step 9 - target_coverage_verify

## Purpose

Determine whether the specific Sonar issue was resolved.

### Before

```json
{
  "file": "OrderService.cs",
  "line": 145,
  "covered": false
}
```

### After

```json
{
  "file": "OrderService.cs",
  "line": 145,
  "covered": true
}
```

### Output

```json
{
  "targetCovered": true,
  "newlyCoveredLines": [145],
  "remainingLines": []
}
```

---

# Decision Node

## Success Condition

```text
targetCovered == true
```

Not:

```text
coverageDelta > 0
```

This ensures the original Sonar issue is eliminated.

---

# Success Path

```text
targetCovered == true
```

### Actions

1. coverage_memory.write(resolved=true)
2. Generate git diff
3. Optional Sonar validation scan
4. Present changes to developer

### Human Review

Developer sees:

```diff
+ [Fact]
+ public async Task CreateOrder_Should_Throw_When_RepositoryFails()
```

Developer chooses:

* Approve
* Reject
* Modify

### Apply

Changes are applied only after approval.

---

# Retry Path

```text
targetCovered == false
```

### Actions

Update memory:

```json
{
  "attemptCount": 3,
  "strategy": "mock_throw",
  "failureReason": "Branch not reached"
}
```

### Retry

Choose new strategy.

---

# Escalation

When:

```text
attemptCount >= MAX_RETRIES
```

### Mark

```json
{
  "escalate": true
}
```

### Surface to User

Possible reasons:

* Dead code
* Untestable code path
* External dependency limitation
* Incorrect Sonar target
* Generated test limitation

Agent stops retrying.

---

# Coverage Memory Schema

```json
{
  "file": "OrderService.cs",
  "line": 145,
  "attempted": true,
  "attemptCount": 2,
  "failureReason": "Dependency throws before target branch",
  "strategiesAttempted": [
    "mock_throw",
    "null_dependency"
  ],
  "resolved": false,
  "escalate": false
}
```

---

# Tool Registry

## External Systems

* sonar_fetch
* build_verify
* git_diff

## IDE / LSP

* file_type_detect
* symbol_lookup
* find_references
* find_tests

## Analysis

* coverage_baseline
* dependency_graph_analyze
* target_code_analyze
* target_coverage_verify

## Configuration

* test_pattern_lookup

## Memory

* coverage_memory.read
* coverage_memory.write

## Native Agent Actions

* generate_test

---

# Success Metrics

## Primary

* Sonar issue resolved

## Secondary

* Coverage increase
* Branch coverage increase
* Build success
* Test success

## Tertiary

* Reduced manual effort
* Faster quality gate compliance

---

# Future Enhancements

## Phase 2

Add:

```text
@sonar.fix
```

Capabilities:

* Fix code smells
* Fix vulnerabilities
* Fix security hotspots

---

## Phase 3

MCP Server Integration

Expose tools:

* SonarQube API
* Roslyn Analysis
* Build Pipeline
* Coverage Reports
* Git Operations

This allows Copilot Chat and future AI agents to reuse the same toolchain without rewriting VS Code extension logic.
