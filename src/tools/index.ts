// ─────────────────────────────────────────────────────────────
// @coverage agent — Tools Barrel
// Re-exports all tools grouped by category.
// Import from here in coverageAgent.ts:
//   import { sonarFetch, buildVerify, symbolLookup } from '../tools';
// ─────────────────────────────────────────────────────────────

// External systems
export { sonarFetch, coverageBaseline } from './sonarTools';

// IDE / LSP
export { symbolLookup, findReferences, findTests } from './ideTools';

// Analysis
export { dependencyGraphAnalyze, targetCodeAnalyze } from './analysisTools';

// Build & verify
export { buildVerify, targetCoverageVerify } from './buildTools';
