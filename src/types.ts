// ─────────────────────────────────────────────────────────────
// @coverage agent — Core Types
// ─────────────────────────────────────────────────────────────

// ── Project / Language ───────────────────────────────────────

export type ProjectType = 'dotnet' | 'angular' | 'react';

// ── Org Pattern Config ───────────────────────────────────────

export interface PatternSpec {
  framework:  string;
  mocking:    string;
  assertion:  string;
  pattern:    'AAA';
  naming:     string;
  baseClass?: string;
  fixtures?:  string[];
  utilities?: string[];
  maxRetries: number;
}

export interface OrgConfig {
  dotnet:  PatternSpec;
  angular: PatternSpec;
  react:   PatternSpec;
}

// ── Sonar (via MCP server) ───────────────────────────────────

export type SonarIssueType = 'coverage' | 'branch_coverage' | 'vulnerability';

export interface SonarIssue {
  file: string;
  line: number;
  type: SonarIssueType;
}

export interface SonarFetchInput {
  projectKey: string;
  branch:     string;
}

export interface SonarFetchOutput {
  issues: SonarIssue[];
}

export interface CoverageBaseline {
  coverage:       number;
  branchCoverage: number;
  issueCount:     number;
}

// ── Symbols / LSP ────────────────────────────────────────────

export interface SymbolLocation {
  class:  string;
  method: string;
  file:   string;
  line:   number;
}

// Caller info from prepareCallHierarchy + provideIncomingCalls
export interface CallerInfo {
  callerClass:  string;
  callerMethod: string;
  interface:    string;
}

export interface FindReferencesOutput {
  method:  string;
  callers: CallerInfo[];
}

export interface FindTestsOutput {
  testFiles:     string[];
  existingTests: string[];
}

// ── Dependency Graph ─────────────────────────────────────────

export interface Dependency {
  interface: string;
  mockName:  string;
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
  error?:         string;
  failureReason?: string;
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
  fileName: string;
  testName: string;
  strategy: string;
  code:     string;
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
