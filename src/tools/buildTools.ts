// ─────────────────────────────────────────────────────────────
// @coverage agent — Build Tools
// build_verify · target_coverage_verify
//
// build_verify runs the appropriate test command per stack
// and returns STRUCTURED output — not just pass/fail.
// The failureReason field is what feeds coverage_memory
// on the retry path, so it must be actionable.
// ─────────────────────────────────────────────────────────────

import * as cp   from 'child_process';
import * as fs   from 'fs/promises';
import * as path from 'path';
import {
  BuildVerifyOutput,
  TargetCoverageOutput,
  ProjectType,
} from '../types';

// ── build_verify ────────────────────────────────────────────

const BUILD_COMMANDS: Record<ProjectType, string> = {
  dotnet:  'dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=json',
  angular: 'npx ng test --watch=false --code-coverage',
  react:   'npx react-scripts test --watchAll=false --coverage',
};

export async function buildVerify(
  workspaceRoot: string,
  projectType:   ProjectType,
): Promise<BuildVerifyOutput> {
  return new Promise(resolve => {
    cp.exec(
      BUILD_COMMANDS[projectType],
      { cwd: workspaceRoot, timeout: 120_000 },
      (err, stdout, stderr) => {
        if (!err) {
          const passed = parseInt(stdout.match(/(\d+) passed/)?.[1] ?? '0');
          const failed = parseInt(stdout.match(/(\d+) failed/)?.[1] ?? '0');

          resolve({
            buildSuccess: true,
            testsPassed:  passed,
            testsFailed:  failed,
            coverageFile: path.join(workspaceRoot, 'coverage.json'),
          });
        } else {
          const compilerError = stderr.match(/error \w+\d+: (.+)/)?.[1];
          const testError     = stdout.match(/Failed:\s+(.+)/)?.[1];
          const rawError      = compilerError ?? testError ?? stderr.slice(0, 200);

          resolve({
            buildSuccess:  false,
            testsPassed:   0,
            testsFailed:   1,
            error:         rawError,
            failureReason: classifyFailure(rawError),
            coverageFile:  null,
          });
        }
      },
    );
  });
}

// Maps raw compiler/test output to a human-readable reason
// that gets written into coverage_memory for the retry loop
function classifyFailure(error: string): string {
  if (/could not be found|not found/i.test(error))
    return 'Missing using directive for mocked dependency';
  if (/NullReference/i.test(error))
    return 'Null reference — missing mock setup in constructor';
  if (/No tests/i.test(error))
    return 'Test method not detected — check naming convention';
  if (/timeout/i.test(error))
    return 'Build timeout — project may have unresolved references';
  return error;
}

// ── target_coverage_verify ──────────────────────────────────
//
// Checks the SPECIFIC Sonar line — not overall coverage delta.
// A positive delta could come from an unrelated line while the
// actual target remains uncovered.

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
