// ─────────────────────────────────────────────────────────────
// @coverage agent — generate_test (native LLM action)
// Builds the prompt from all context and calls the LLM.
// This is NOT a tool call — it is the agent's core action.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { GenerateTestInput, GeneratedTest } from '../types';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export async function generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
  const {
    sonarIssue, patternSpec, symbol,
    references, existingTests,
    dependencies, codeAnalysis, memory,
  } = input;

  // ── Build strategy guidance from memory ─────────────────
  const memoryContext = memory
    ? `
PREVIOUS ATTEMPTS: ${memory.attemptCount}
STRATEGIES ALREADY TRIED (do NOT repeat): ${memory.strategiesAttempted.join(', ')}
LAST FAILURE REASON: ${memory.failureReason}

Choose a DIFFERENT strategy from those already attempted.
    `.trim()
    : 'This is the first attempt. Start with the most likely scenario (e.g. null input, guard clause).';

  // ── Build existing test examples ─────────────────────────
  const existingTestsContext = existingTests.existingTests.length
    ? `EXISTING TEST NAMES IN THIS CLASS (follow this naming style exactly):
${existingTests.existingTests.map(t => `  - ${t}`).join('\n')}`
    : 'No existing tests found. Use the naming convention from the pattern spec.';

  // ── Build dependency mock list ───────────────────────────
  const depsContext = dependencies.dependencies.length
    ? dependencies.dependencies
        .map(d => `  - ${d.interface} → mock as ${d.mockName}`)
        .join('\n')
    : 'No constructor dependencies detected.';

  // ── Final prompt ─────────────────────────────────────────
  const prompt = `
You are a senior ${patternSpec.framework} test engineer.

Generate a SINGLE unit test that covers the following SonarQube issue:

TARGET
  File:   ${sonarIssue.file}
  Line:   ${sonarIssue.line}
  Method: ${symbol.class}.${symbol.method}

ORG TEST PATTERN
  Framework:  ${patternSpec.framework}
  Mocking:    ${patternSpec.mocking}
  Assertion:  ${patternSpec.assertion}
  Pattern:    ${patternSpec.pattern} (Arrange / Act / Assert)
  Naming:     ${patternSpec.naming}
  ${patternSpec.baseClass ? `Base class: ${patternSpec.baseClass}` : ''}

${existingTestsContext}

CONSTRUCTOR DEPENDENCIES TO MOCK
${depsContext}

METHOD ANALYSIS
  Branches:   ${codeAnalysis.branches}
  Exceptions: ${codeAnalysis.exceptions}
  Guards:     ${codeAnalysis.guards.join('; ') || 'none'}
  Deps used in this method: ${codeAnalysis.dependenciesUsed.join(', ') || 'none'}

${memoryContext}

RULES
1. Cover line ${sonarIssue.line} specifically — not just any line
2. Follow the ${patternSpec.pattern} pattern with clear Arrange/Act/Assert comments
3. Use ${patternSpec.mocking} for all mocks
4. Name the test exactly following: ${patternSpec.naming}
5. Do NOT use [Fact] and [Theory] together — pick one
6. The test must COMPILE — include all necessary using statements
7. Return ONLY the test method code, no class wrapper, no explanation

Respond in this exact JSON format:
{
  "testName": "...",
  "strategy": "one_word_strategy_label",
  "code": "full test method source here"
}
`.trim();

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  // ── Parse response ───────────────────────────────────────
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  const clean   = text.replace(/```json|```/g, '').trim();
  const parsed  = JSON.parse(clean) as { testName: string; strategy: string; code: string };

  // Derive test file name from class name
  const ext      = sonarIssue.file.endsWith('.cs') ? 'cs'
    : sonarIssue.file.endsWith('.tsx')              ? 'tsx'
    : 'spec.ts';

  const fileName = `${symbol.class}Tests.${ext}`;

  return {
    fileName,
    testName: parsed.testName,
    strategy: parsed.strategy,
    code:     parsed.code,
  };
}
