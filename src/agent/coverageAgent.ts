// ─────────────────────────────────────────────────────────────
// @coverage agent — Main Agent Loop
// Phase 1: setup (runs once)
// Phase 2: per-line retry loop (runs per Sonar issue)
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { CoverageMemory }     from '../memory/coverageMemory';
import { fileTypeDetect, testPatternLookup } from '../config/patternConfig';
import {
  sonarFetch, coverageBaseline,
  symbolLookup, findReferences, findTests,
  dependencyGraphAnalyze, targetCodeAnalyze,
  buildVerify, targetCoverageVerify,
} from '../tools';
import { generateTest }       from './generateTest';
import { SonarIssue, PatternSpec } from '../types';

export class CoverageAgent {
  private readonly memory: CoverageMemory;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.memory = new CoverageMemory(context);
  }

  // ── Entry point — called by the Chat Participant handler ──

  async run(
    stream:    vscode.ChatResponseStream,
    projectKey: string,
    branch:    string,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';
    const sonarUrl      = vscode.workspace.getConfiguration('coverage').get<string>('sonarUrl')   ?? '';
    const sonarToken    = vscode.workspace.getConfiguration('coverage').get<string>('sonarToken') ?? '';

    // ════════════════════════════════════════════════════════
    // PHASE 1 — SETUP (runs once)
    // ════════════════════════════════════════════════════════

    stream.markdown('**Phase 1 — Setup**\n\n');

    // 1. sonar_fetch
    stream.progress('Fetching SonarQube issues...');
    const { issues } = await sonarFetch({ projectKey, branch }, sonarUrl, sonarToken);
    stream.markdown(`Found **${issues.length}** coverage issues to resolve.\n\n`);

    if (issues.length === 0) {
      stream.markdown('✅ No coverage issues found. Nothing to do.');
      return;
    }

    // 2. coverage_baseline
    stream.progress('Capturing coverage baseline...');
    const baseline = await coverageBaseline(projectKey, sonarUrl, sonarToken);
    stream.markdown(
      `Baseline: **${baseline.coverage}%** coverage · **${baseline.branchCoverage}%** branch coverage\n\n`,
    );

    // 3. file_type_detect (from first issue — all files in the same project)
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const projectType = fileTypeDetect(issues[0].file, workspaceFolders);

    // 4. test_pattern_lookup — static config, runs once
    const patternSpec: PatternSpec = testPatternLookup(projectType);
    stream.markdown(
      `Stack detected: **${projectType}** · Using **${patternSpec.framework}** + **${patternSpec.mocking}**\n\n`,
    );

    stream.markdown('---\n\n**Phase 2 — Resolving issues**\n\n');

    // ════════════════════════════════════════════════════════
    // PHASE 2 — PER-LINE RETRY LOOP
    // ════════════════════════════════════════════════════════

    for (const issue of issues) {
      await this.resolveIssue(stream, issue, patternSpec, projectType, workspaceRoot);
    }

    stream.markdown('\n\n---\n✅ All issues processed.');
  }

  // ── Per-issue resolution with retry loop ─────────────────

  private async resolveIssue(
    stream:        vscode.ChatResponseStream,
    issue:         SonarIssue,
    patternSpec:   PatternSpec,
    projectType:   'dotnet' | 'angular' | 'react',
    workspaceRoot: string,
  ): Promise<void> {
    stream.markdown(`\n### \`${issue.file}:${issue.line}\`\n`);

    // Check memory — skip if previously escalated or resolved
    const existingMemory = await this.memory.read(issue.file, issue.line);
    if (existingMemory?.escalate) {
      stream.markdown(`⚠️ Previously escalated — skipping.\n`);
      return;
    }
    if (existingMemory?.resolved) {
      stream.markdown(`✅ Previously resolved — skipping.\n`);
      return;
    }

    // ── Gather context (runs once per issue, outside retry loop) ──

    stream.progress('Resolving symbol...');
    const symbol = await symbolLookup(issue.file, issue.line);

    stream.progress('Building call graph...');
    const references = await findReferences(symbol);

    stream.progress('Finding existing tests...');
    const existingTests = await findTests(symbol);

    stream.progress('Analyzing dependencies...');
    const dependencies = await dependencyGraphAnalyze(symbol);

    // ── Retry loop ───────────────────────────────────────────

    let targetCovered = false;
    let attemptCount  = existingMemory?.attemptCount ?? 0;
    const maxRetries  = patternSpec.maxRetries;

    while (!targetCovered && attemptCount < maxRetries) {
      const attempt = attemptCount + 1;
      stream.progress(`Attempt ${attempt}/${maxRetries} — analysing target method...`);

      // Re-read memory at the start of each attempt
      const memory = await this.memory.read(issue.file, issue.line);

      // target_code_analyze — inside loop so it refreshes context
      const codeAnalysis = await targetCodeAnalyze(symbol);

      // generate_test — LLM native action
      stream.progress(`Attempt ${attempt}/${maxRetries} — generating test...`);
      const generated = await generateTest({
        sonarIssue:   issue,
        patternSpec,
        symbol,
        references,
        existingTests,
        dependencies,
        codeAnalysis,
        memory,
      });

      stream.markdown(
        `\n**Attempt ${attempt}/${maxRetries}** — Strategy: \`${generated.strategy}\`\n\n`
        + '```csharp\n' + generated.code + '\n```\n',
      );

      // build_verify
      stream.progress('Building and running tests...');
      const buildResult = await buildVerify(workspaceRoot, projectType);

      if (!buildResult.buildSuccess) {
        stream.markdown(`❌ Build failed: \`${buildResult.failureReason}\`\n`);
        await this.memory.writeFailure(issue.file, issue.line, generated.strategy, buildResult);
        attemptCount++;
        continue;
      }

      // target_coverage_verify — checks the SPECIFIC Sonar line
      const coverageResult = await targetCoverageVerify(
        issue.file,
        issue.line,
        buildResult.coverageFile!,
      );

      targetCovered = coverageResult.targetCovered;

      if (targetCovered) {
        // ── SUCCESS PATH ──────────────────────────────────
        await this.memory.writeSuccess(issue.file, issue.line);
        await this.presentForReview(stream, generated, issue);
      } else {
        // ── RETRY PATH ────────────────────────────────────
        stream.markdown(`⚠️ Build passed but line ${issue.line} still not covered.\n`);
        await this.memory.writeFailure(
          issue.file, issue.line, generated.strategy,
          { ...buildResult, failureReason: `Line ${issue.line} not hit by test` },
        );
        attemptCount++;

        if (attemptCount < maxRetries) {
          stream.markdown(
            `Retrying with a different strategy `
            + `(attempt ${attemptCount + 1}/${maxRetries})...\n`,
          );
        }
      }
    }

    // ── ESCALATION ───────────────────────────────────────────
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

  // ── Present generated test for human review ───────────────

  private async presentForReview(
    stream:    vscode.ChatResponseStream,
    generated: { fileName: string; testName: string; code: string },
    issue:     SonarIssue,
  ): Promise<void> {
    stream.markdown(
      `\n✅ **Line ${issue.line} covered!**\n\n`
      + `Test: \`${generated.testName}\`\n\n`
      + 'Review the generated test and choose an action:\n',
    );

    // VS Code Chat buttons — human-in-the-loop gate
    stream.button({
      command: 'coverage.approveTest',
      title:   '✅ Approve & Apply',
      arguments: [generated],
    });
    stream.button({
      command: 'coverage.rejectTest',
      title:   '❌ Reject',
      arguments: [generated],
    });
  }
}
