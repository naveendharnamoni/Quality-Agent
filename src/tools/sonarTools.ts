// ─────────────────────────────────────────────────────────────
// @coverage agent — Sonar Tools
// sonar_fetch · coverage_baseline
// ─────────────────────────────────────────────────────────────

import {
  SonarFetchInput,
  SonarFetchOutput,
  CoverageBaseline,
} from '../types';

// ── sonar_fetch ─────────────────────────────────────────────

export async function sonarFetch(
  input:      SonarFetchInput,
  sonarUrl:   string,
  sonarToken: string,
): Promise<SonarFetchOutput> {
  const url =
    `${sonarUrl}/api/issues/search`
    + `?componentKeys=${input.projectKey}`
    + `&branch=${input.branch}`
    + `&types=CODE_SMELL,BUG,VULNERABILITY`
    + `&resolved=false`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${sonarToken}` },
  });

  if (!res.ok) {
    throw new Error(`sonar_fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    issues: Array<{ component: string; line: number; type: string }>;
  };

  return {
    issues: data.issues.map(i => ({
      file: i.component.split(':').pop() ?? i.component,
      line: i.line,
      type: i.type === 'BUG' ? 'coverage' : 'branch_coverage',
    })),
  };
}

// ── coverage_baseline ───────────────────────────────────────

export async function coverageBaseline(
  projectKey: string,
  sonarUrl:   string,
  sonarToken: string,
): Promise<CoverageBaseline> {
  const url =
    `${sonarUrl}/api/measures/component`
    + `?component=${projectKey}`
    + `&metricKeys=coverage,branch_coverage,violations`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${sonarToken}` },
  });

  const data = await res.json() as {
    component: { measures: Array<{ metric: string; value: string }> };
  };

  const get = (key: string) =>
    parseFloat(data.component.measures.find(m => m.metric === key)?.value ?? '0');

  return {
    coverage:       get('coverage'),
    branchCoverage: get('branch_coverage'),
    issueCount:     Math.round(get('violations')),
  };
}
