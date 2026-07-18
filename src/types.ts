// ─────────────────────────────────────────────────────────────
// @coverage agent — Core Types
// ─────────────────────────────────────────────────────────────

// ── Project / Language ───────────────────────────────────────

export type ProjectType = 'dotnet' | 'angular' | 'react';

// ── Org Pattern Config ───────────────────────────────────────

export interface PatternSpec {
  framework:  string;       // xUnit | Jasmine | Jest
  mocking:    string;       // Moq | SpyObj | jest.mock
  assertion:  string;       // FluentAssertions | expect()
  pattern:    'AAA';
  naming:     string;       // "{Method}_Should_{Behavior}_When_{Condition}"
  baseClass?: string;       // BaseApiTest (dotnet only)
  fixtures?:  string[];     // WebApplicationFactory, InMemoryDb ...
  utilities?: string[];     // TestBed, render, screen ...
  maxRetries: number;
}

export interface OrgConfig {
  dotnet:  PatternSpec;
  angular: PatternSpec;
  react:   PatternSpec;
}

// ── Sonar ────────────────────────────────────────────────────

export type SonarIssueType = 'coverage' | 'branch_coverage' | 'vulnerability';

export interface SonarIssue {
  file: string;             // "OrderService.cs"
  line: number;             // 145
  type: SonarIssueType;
}

export interface SonarFetchInput {
  projectKey: string;
  branch:     string;
}

export interface SonarFetchOutput {
  issues: SonarIssue[];
}

// ── Coverage Baseline ────────────────────────────────────────

export interface CoverageBaseline {
  coverage:       number;   // 72.4
  branchCoverage: number;   // 68.9
  issueCount:     number;   // 42
}

// ── Symbols / LSP ────────────────────────────────────────────

export interface SymbolLocation {
  class:  string;
  method: string;
  file:   string;
  line:   number;
}

export interface Reference {
  callee:    string;        // method name called
  interface: string;        // interface it belongs to
}

export interface FindReferencesOutput {
  method:     string;
  references: Reference[];
}

export interface FindTestsOutput {
  testFiles:     string[];
  existingTests: string[];
}

// ── Dependency Graph ─────────────────────────────────────────

export interface Dependency {
  interface: string;        // "IRepository<Order>"
  mockName:  string;        // "_repository"
}

export interface DependencyGraphOutput {
  dependencies: Dependency[];
}

// ── Target Code Analysis ─────────────────────────────────────

export interface TargetCodeOutput {
  method:           string;
  branches:         number;
  exceptions:       number;
  guards:           string[];
  targetLine:       number;
  dependenciesUsed: string[];
}

// ── Coverage Memory ──────────────────────────────────────────

export interface CoverageMemoryRecord {
  file:                string;
  line:                number;
  attempted:           boolean;
  attemptCount:        number;
  failureReason:       string;
  strategiesAttempted: string[];
  resolved:            boolean;
  escalate:            boolean;
}

// ── Build / Verify ───────────────────────────────────────────

export interface BuildVerifyOutput {
  buildSuccess:   boolean;
  testsPassed:    number;
  testsFailed:    number;
  error?:         string;   // compiler / runtime error message
  failureReason?: string;   // human-readable reason for retry context
  coverageFile:   string | null;
}

export interface TargetCoverageOutput {
  targetCovered:     boolean;
  newlyCoveredLines: number[];
  remainingLines:    number[];
}

// ── Generate Test ────────────────────────────────────────────

export interface GenerateTestInput {
  sonarIssue:    SonarIssue;
  patternSpec:   PatternSpec;
  symbol:        SymbolLocation;
  references:    FindReferencesOutput;
  existingTests: FindTestsOutput;
  dependencies:  DependencyGraphOutput;
  codeAnalysis:  TargetCodeOutput;
  memory:        CoverageMemoryRecord | null;
}

export interface GeneratedTest {
  fileName: string;         // "OrderServiceTests.cs"
  testName: string;         // "CreateOrder_Should_Throw_When_RepositoryFails"
  strategy: string;         // "mock_throw" — written to memory after attempt
  code:     string;         // full test method source
}

// ── Loop State ───────────────────────────────────────────────

export interface LoopContext {
  issue:        SonarIssue;
  projectType:  ProjectType;
  patternSpec:  PatternSpec;
  attemptCount: number;
  resolved:     boolean;
  escalated:    boolean;
}
