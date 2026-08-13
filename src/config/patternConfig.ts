// ─────────────────────────────────────────────────────────────
// @coverage agent — Org Pattern Config
// Static lookup — no runtime discovery needed.
// file_type_detect maps extension → ProjectType.
// test_pattern_lookup returns frozen PatternSpec from config.
// ─────────────────────────────────────────────────────────────

import { OrgConfig, PatternSpec, ProjectType } from '../types';

const ORG_CONFIG: OrgConfig = {
  dotnet: {
    framework:  'xUnit',
    mocking:    'Moq',
    assertion:  'FluentAssertions',
    pattern:    'AAA',
    naming:     '{Method}_Should_{Behavior}_When_{Condition}',
    baseClass:  'BaseApiTest',
    fixtures:   ['WebApplicationFactory', 'InMemoryDb'],
    maxRetries: 3,
  },
  angular: {
    framework:  'Jasmine',
    mocking:    'SpyObj',
    assertion:  'expect()',
    pattern:    'AAA',
    naming:     'should {behavior} when {condition}',
    utilities:  ['TestBed', 'HttpClientTestingModule', 'RouterTestingModule'],
    maxRetries: 3,
  },
  react: {
    framework:  'Jest',
    mocking:    'jest.mock',
    assertion:  'expect()',
    pattern:    'AAA',
    naming:     '{Component} - should {behavior} when {condition}',
    utilities:  ['render', 'screen', 'userEvent', 'MSW'],
    maxRetries: 3,
  },
};

/**
 * test_pattern_lookup
 * Key lookup against static config — not a codebase scan.
 * Runs once in Phase 1 setup. PatternSpec is injected into
 * the retry loop context for all subsequent iterations.
 */
export function testPatternLookup(projectType: ProjectType): PatternSpec {
  return ORG_CONFIG[projectType];
}

/**
 * file_type_detect
 * Infers ProjectType from file extension + workspace layout.
 *   .cs              → dotnet
 *   .tsx / .jsx      → react
 *   .ts / .html      → angular (if angular.json present), else react
 */
export function fileTypeDetect(
  filePath:         string,
  workspaceFolders: string[],
): ProjectType {
  if (filePath.endsWith('.cs'))                               return 'dotnet';
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'react';

  const isAngular = workspaceFolders.some(f => f.includes('angular.json'));
  if (isAngular) return 'angular';

  return 'react';
}
