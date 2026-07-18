// ─────────────────────────────────────────────────────────────
// @coverage agent — Org Pattern Config
// Static lookup — no runtime discovery
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
 * Returns the frozen PatternSpec for the given project type.
 * This is a key lookup — not a codebase scan.
 */
export function testPatternLookup(projectType: ProjectType): PatternSpec {
  return ORG_CONFIG[projectType];
}

/**
 * file_type_detect
 * Infers project type from file extension / workspace context.
 */
export function fileTypeDetect(filePath: string, workspaceFolders: string[]): ProjectType {
  if (filePath.endsWith('.cs'))                            return 'dotnet';
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'react';

  // .ts or .html — check workspace for angular.json
  const isAngular = workspaceFolders.some(f => f.includes('angular.json'));
  if (isAngular)                                           return 'angular';

  return 'react'; // ts without angular.json → React
}
