// ─────────────────────────────────────────────────────────────
// @coverage agent — Sonar Tools
// sonar_fetch · coverage_baseline
//
// REPLACED: raw REST calls → SonarQube official MCP server
// (sonarsource/sonarqube-mcp)
//
// Config required in VS Code settings:
//   coverage.sonarUrl   = https://sonar.yourorg.com
//   coverage.sonarToken = <your-token>
//
// The MCP server handles auth, rate limiting, and pagination.
// sonar_fetch   → MCP tool: search_issues
// coverage_baseline → MCP tool: get_measures
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { SonarFetchInput, SonarFetchOutput, CoverageBaseline, SonarIssue } from '../types';

// ── MCP client helper ────────────────────────────────────────
// VS Code exposes connected MCP servers through the language model
// tool API. We call SonarQube MCP tools via lm.invokeTool().

async function callSonarMcp<T>(
  toolName: string,
  params:   Record<string, unknown>,
): Promise<T> {
  // Retrieve available language model tools registered by the MCP server
  const tools = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!tools.length) {
    throw new Error('No Copilot language model available — check Copilot connection');
  }

  // Call the MCP tool through VS Code's lm tool invocation API
  const result = await vscode.lm.invokeTool(toolName, { input: params }, new vscode.CancellationTokenSource().token);

  const text = result.content
    .filter((c): c is vscode.LanguageModelTextPart => c instanceof vscode.LanguageModelTextPart)
    .map(c => c.value)
    .join('');

  return JSON.parse(text) as T;
}

// ── sonar_fetch ─────────────────────────────────────────────
// Delegates to MCP tool: search_issues
// Supports self-hosted SonarQube via SONARQUBE_URL env var
// set in the MCP server configuration.

export async function sonarFetch(
  input: SonarFetchInput,
): Promise<SonarFetchOutput> {
  type McpIssue = { component: string; line: number; type: string };

  const data = await callSonarMcp<{ issues: McpIssue[] }>('search_issues', {
    projectKey: input.projectKey,
    branch:     input.branch,
    resolved:   false,
  });

  const issues: SonarIssue[] = data.issues.map(i => ({
    file: i.component.split(':').pop() ?? i.component,
    line: i.line,
    type: i.type === 'BUG' ? 'coverage' : 'branch_coverage',
  }));

  return { issues };
}

// ── coverage_baseline ────────────────────────────────────────
// Delegates to MCP tool: get_measures
// Captures pre-modification metrics for reporting only.
// NOT used as the success condition (targetCovered is).

export async function coverageBaseline(
  projectKey: string,
): Promise<CoverageBaseline> {
  type McpMeasure = { metric: string; value: string };

  const data = await callSonarMcp<{ measures: McpMeasure[] }>('get_measures', {
    component:  projectKey,
    metricKeys: ['coverage', 'branch_coverage', 'violations'],
  });

  const get = (key: string) =>
    parseFloat(data.measures.find(m => m.metric === key)?.value ?? '0');

  return {
    coverage:       get('coverage'),
    branchCoverage: get('branch_coverage'),
    issueCount:     Math.round(get('violations')),
  };
}
