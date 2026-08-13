// ─────────────────────────────────────────────────────────────
// @coverage agent — Main Agent Loop
//
// Phase 1 — Setup (runs once per invocation)
//   sonar_fetch → coverage_baseline → file_type_detect
//   → test_pattern_lookup
//
// Phase 2 — Per-line retry loop (runs per Sonar issue)
//   symbol_lookup → find_references → find_tests
//   → dependency_graph_analyze → target_code_analyze
//   → coverage_memory.read → generate_test
//   → build_verify → target_coverage_verify
//   → decision: success / retry / escalate
//
// UPDATED:
//   - Apply test delegates to #edit/editFiles (IC-05)
//   - git_diff delegates to #search/changes (IC-06)
//   - Retry visibility surfaced in chat on every attempt
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { CoverageMemory }                  from '../memory/coverageMemory';
import { fileTypeDetect, testPatternLookup } from '../config/patternConfig';
import {
  sonarFetch, coverageBaseline,
  symbolLookup, findReferences, findTests,
  dependencyGraphAnalyze, targetCodeAnalyze,
  buildVerify, targetCoverageVerify,
} from '../tools';
import { generateTest }                    from './generateTest';
import { SonarIssue, PatternSpec, GeneratedTest } from '../types';

export class CoverageAgent {
  private readonly memory: CoverageMemory;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.memory = new CoverageMemory(context);
  }

  // ── Entry point — called by the Chat Participant handler ──

  async run(
    stream:     vscode.ChatResponseStream,
    projectKey: string,
    branch:     string,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';

    // ══════════════════════════════════════════════════════
    // PHASE 1 — SETUP
    // ══════════════════════════════════════════════════════

    stream.markdown('## Phase 1 — Setup\n\n');

    // 1. sonar_fetch — via SonarQube MCP server
    stream.progress('Fetching SonarQube issues...');
    const { issues } = await sonarFetch({ projectKey, branch });
    stream.markdown(`Found **${issues.length}** coverage issues.\n\n`);

    if (issues.length === 0) {
      stream.markdown('✅ No coverage issues found — nothing to do.');
      return;
    }

    // 2. coverage_baseline — via SonarQube MCP server
    stream.progress('Capturing coverage baseline...');
    const baseline = await coverageBaseline(projectKey);
    stream.markdown(
      `Baseline: **${baseline.coverage}%** coverage · **${baseline.branchCoverage}%** branch\n\n`,
    );

    // 3. file_type_detect — static mapping from extension
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const projectType      = fileTypeDetect(issues[0].file, workspaceFolders);

    // 4. test_pattern_lookup — static config key lookup (runs ONCE, not per line)
    const patternSpec: PatternSpec = testPatternLookup(projectType);
    stream.markdown(
      `Stack: **${projectType}** · **${patternSpec.framework}** + **${patternSpec.mocking}**\n\n`,
    );

    stream.markdown('---\n\n## Phase 2 — Resolving Issues\n\n');

    // ══════════════════════════════════════════════════════
    // PHASE 2 — PER-LINE RETRY LOOP
    // ══════════════════════════════════════════════════════

    for (const issue of issues) {
      await this.resolveIssue(stream, issue, patternSpec, projectType, workspaceRoot);
    }

    stream.markdown('\n\n---\n✅ All issues processed.');
  }

  // ── Per-issue resolution ──────────────────────────────────

  private async resolveIssue(
    stream:        vscode.ChatResponseStream,
    issue:         SonarIssue,
    patternSpec:   PatternSpec,
    projectType:   'dotnet' | 'angular' | 'react',
    workspaceRoot: string,
  ): Promise<void> {
    stream.markdown(`\n### \`${issue.file}:${issue.line}\`\n`);

    // Check memory — skip resolved or previously escalated lines
    const existingMemory = await this.memory.read(issue.file, issue.line);
    if (existingMemory?.escalate) {
      stream.markdown('⚠️ Previously escalated — skipping.\n');
      return;
    }
    if (existingMemory?.resolved) {
      stream.markdown('✅ Previously resolved — skipping.\n');
      return;
    }

    // ── Gather context once per issue (outside retry loop) ──

    stream.progress('Resolving symbol...');
    const symbol = await symbolLookup(issue.file, issue.line);

    // find_references — Call Hierarchy API (IC-02)
    stream.progress('Building call graph...');
    const references = await findReferences(symbol);

    stream.progress('Finding existing tests...');
    const existingTests = await findTests(symbol);

    // dependency_graph_analyze — custom, no built-in equivalent
    stream.progress('Analyzing dependencies...');
    const dependencies = await dependencyGraphAnalyze(symbol);

    // ── Retry loop ────────────────────────────────────────

    let targetCovered = false;
    let attemptCount  = existingMemory?.attemptCount ?? 0;
    const maxRetries  = patternSpec.maxRetries;

    while (!targetCovered && attemptCount < maxRetries) {
      const attempt = attemptCount + 1;

      // Re-read memory at each attempt start — always fresh
      const memory = await this.memory.read(issue.file, issue.line);

      // target_code_analyze — custom, inside loop for fresh context
      stream.progress(`[${attempt}/${maxRetries}] Analysing target method...`);
      const codeAnalysis = await targetCodeAnalyze(symbol);

      // generate_test — LLM native action
      stream.progress(`[${attempt}/${maxRetries}] Generating test...`);
      let generated: GeneratedTest;
      try {
        generated = await generateTest({
          sonarIssue: issue, patternSpec, symbol,
          references, existingTests, dependencies,
          codeAnalysis, memory,
        });
      } catch (err) {
        stream.markdown(`❌ Generation failed: ${String(err)}\n`);
        break;
      }

      // Surface attempt context to developer — never silently spin
      if (attempt > 1) {
        stream.markdown(
          `\n**[Attempt ${attempt}/${maxRetries}]** — Previous strategy \`${
            memory?.strategiesAttempted.at(-1) ?? ''
          }\` failed: _${memory?.failureReason}_\n`
          + `Trying: \`${generated.strategy}\`\n\n`,
        );
      } else {
        stream.markdown(`\n**[Attempt ${attempt}/${maxRetries}]** — Strategy: \`${generated.strategy}\`\n\n`);
      }

      stream.markdown('```csharp\n' + generated.code + '\n```\n');

      // build_verify — delegates to Copilot built-in terminal tools (IC-04)
      stream.progress(`[${attempt}/${maxRetries}] Building and running tests...`);
      const buildResult = await buildVerify(workspaceRoot, projectType);

      if (!buildResult.buildSuccess) {
        stream.markdown(`❌ Build failed: \`${buildResult.failureReason}\`\n`);
        await this.memory.writeFailure(issue.file, issue.line, generated.strategy, buildResult);
        attemptCount++;
        continue;
      }

      // target_coverage_verify — checks the SPECIFIC Sonar line (custom)
      const coverageResult = await targetCoverageVerify(
        issue.file, issue.line, buildResult.coverageFile!,
      );
      targetCovered = coverageResult.targetCovered;

      if (targetCovered) {
        // ── SUCCESS PATH ───────────────────────────────
        await this.memory.writeSuccess(issue.file, issue.line);
        await this.presentForReview(stream, generated, issue);
      } else {
        // ── RETRY PATH ────────────────────────────────
        stream.markdown(`⚠️ Build passed but line ${issue.line} still not covered.\n`);
        await this.memory.writeFailure(
          issue.file, issue.line, generated.strategy,
          { ...buildResult, failureReason: `Line ${issue.line} not hit despite passing test` },
        );
        attemptCount++;
      }
    }

    // ── ESCALATION ────────────────────────────────────────

    if (!targetCovered) {
      await this.memory.writeEscalation(issue.file, issue.line);
      stream.markdown(
        `\n⚠️ **Escalated** — Could not cover \`${issue.file}:${issue.line}\` `
        + `after ${maxRetries} attempts.\n\n`
        + `Possible reasons:\n`
        + `- Dead code — line may be unreachable in practice\n`
        + `- Untestable path — requires external system state\n`
        + `- External dependency limitation — cannot be mocked at this boundary\n`
        + `- Incorrect Sonar target — generated or platform code\n\n`
        + `**Recommended action:** Review manually or suppress with justification.\n`,
      );
    }
  }

  // ── Present for human review ──────────────────────────────
  // Changes are NEVER applied without explicit approval.
  // Apply delegates to Copilot #edit/editFiles (IC-05).
  // Diff delegates to Copilot #search/changes (IC-06).

  private async presentForReview(
    stream:    vscode.ChatResponseStream,
    generated: GeneratedTest,
    issue:     SonarIssue,
  ): Promise<void> {
    stream.markdown(
      `\n✅ **Line ${issue.line} covered!**\n\n`
      + `Test: \`${generated.testName}\`\n\n`
      + `Review the diff and choose an action:\n`,
    );

    stream.button({
      command:   'coverage.approveTest',
      title:     '✅ Approve & Apply',
      arguments: [generated],
    });

    stream.button({
      command:   'coverage.rejectTest',
      title:     '❌ Reject',
      arguments: [generated],
    });
  }
}
