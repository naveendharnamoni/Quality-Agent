// ─────────────────────────────────────────────────────────────
// @coverage agent — Build Tools
// build_verify · target_coverage_verify
//
// UPDATED (IC-04):
//   build_verify now delegates to Copilot built-in tools:
//     #execute/runInTerminal    — runs dotnet/ng/react test cmd
//     #execute/getTerminalOutput — gets structured stdout/stderr
//     #execute/testFailure      — structured test failure detail
//   No child_process.exec needed.
//
// target_coverage_verify has no built-in equivalent.
//   Parses Coverlet/Istanbul JSON to confirm the SPECIFIC
//   Sonar line is hit — not just that overall coverage went up.
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as fs     from 'fs/promises';
import * as path   from 'path';
import { BuildVerifyOutput, TargetCoverageOutput, ProjectType } from '../types';

// ── build_verify ─────────────────────────────────────────────

const BUILD_COMMANDS: Record<ProjectType, string> = {
  dotnet:  'dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=json',
  angular: 'npx ng test --watch=false --code-coverage',
  react:   'npx react-scripts test --watchAll=false --coverage',
};

export async function buildVerify(
  workspaceRoot: string,
  projectType:   ProjectType,
): Promise<BuildVerifyOutput> {
  const command = BUILD_COMMANDS[projectType];

  // Delegate to Copilot built-in terminal execution
  // #execute/runInTerminal runs the command in the integrated terminal
  await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
    text: `cd "${workspaceRoot}" && ${command}\n`,
  });

  // #execute/getTerminalOutput — wait briefly then read terminal output
  // In production wire this to the terminal data event for reliability
  await new Promise(r => setTimeout(r, 8000));

  const terminalOutput = await vscode.commands.executeCommand<string>(
    'workbench.action.terminal.getLastOutput',
  ) ?? '';

  // #execute/testFailure — get structured test failures if any
  const testDiagnostics = vscode.languages.getDiagnostics();
  const errors = testDiagnostics
    .flatMap(([, diags]) => diags)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

  if (errors.length > 0) {
    const rawError = errors[0].message;
    return {
      buildSuccess:  false,
      testsPassed:   0,
      testsFailed:   errors.length,
      error:         rawError,
      failureReason: classifyFailure(rawError),
      coverageFile:  null,
    };
  }

  // Parse pass/fail counts from terminal output
  const passed = parseInt(terminalOutput.match(/(\d+) passed/)?.[1]  ?? '0');
  const failed = parseInt(terminalOutput.match(/(\d+) failed/)?.[1]  ?? '0');

  if (failed > 0) {
    const testError = terminalOutput.match(/Failed:\s+(.+)/)?.[1] ?? 'Test failed';
    return {
      buildSuccess:  false,
      testsPassed:   passed,
      testsFailed:   failed,
      error:         testError,
      failureReason: classifyFailure(testError),
      coverageFile:  null,
    };
  }

  return {
    buildSuccess: true,
    testsPassed:  passed,
    testsFailed:  0,
    coverageFile: path.join(workspaceRoot, 'coverage.json'),
  };
}

// Maps raw error text to a human-readable failureReason that
// gets written into coverage_memory for the retry loop signal
function classifyFailure(error: string): string {
  if (/could not be found|not found/i.test(error))
    return 'Missing using directive for mocked dependency';
  if (/NullReference/i.test(error))
    return 'Null reference — missing mock setup in constructor';
  if (/No tests/i.test(error))
    return 'Test method not detected — check naming convention';
  if (/timeout/i.test(error))
    return 'Build timeout — project may have unresolved references';
  return error.slice(0, 200);
}

// ── target_coverage_verify ───────────────────────────────────
// No built-in replacement — custom Coverlet/Istanbul JSON parsing.
// Checks targetCovered on the SPECIFIC Sonar line number.
// A positive coverage delta is not sufficient — the exact line must be hit.

export async function targetCoverageVerify(
  file:         string,
  line:         number,
  coverageFile: string,
): Promise<TargetCoverageOutput> {
  let covered = false;

  try {
    const raw      = await fs.readFile(coverageFile, 'utf-8');
    const coverage = JSON.parse(raw) as Record<string, {
      Lines: Record<string, number>;
    }>;

    // Coverage report keys are full paths — match by filename
    const fileKey = Object.keys(coverage).find(k =>
      k.endsWith(path.basename(file)),
    );

    if (fileKey) {
      const lineHits = coverage[fileKey].Lines[String(line)] ?? 0;
      covered = lineHits > 0;
    }
  } catch {
    // Coverage file missing or malformed — treat as not covered
    covered = false;
  }

  return {
    targetCovered:     covered,
    newlyCoveredLines: covered ? [line] : [],
    remainingLines:    covered ? [] : [line],
  };
}
