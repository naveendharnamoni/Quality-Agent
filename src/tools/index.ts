// ─────────────────────────────────────────────────────────────
// @coverage agent — Tools Barrel
//
// Grouped by source — makes it clear where each tool comes from:
//   sonarTools   → SonarQube MCP server
//   ideTools     → VS Code built-in LSP commands
//   analysisTools → custom built (no equivalent exists)
//   buildTools   → Copilot built-in terminal tools +
//                  custom coverage JSON parsing
// ─────────────────────────────────────────────────────────────

// SonarQube MCP server tools
export { sonarFetch, coverageBaseline } from './sonarTools';

// VS Code built-in LSP tools
export { symbolLookup, findReferences, findTests } from './ideTools';

// Custom analysis tools — no built-in equivalent
export { dependencyGraphAnalyze, targetCodeAnalyze } from './analysisTools';

// Build + coverage verification
export { buildVerify, targetCoverageVerify } from './buildTools';
