// ─────────────────────────────────────────────────────────────
// @coverage agent — generate_test (LLM native action)
//
// Builds the prompt from all gathered context and calls
// the Anthropic SDK. This is NOT a tool call — it is the
// agent's core action. The LLM generates the test; the tools
// gather the context that makes it accurate.
//
// Key prompt inputs:
//   PatternSpec   → org naming convention + framework (injected verbatim)
//   dependencies  → what to mock and exact mock variable names
//   codeAnalysis  → which branches/exceptions need hitting
//   memory        → strategies already tried (agent must avoid repeating)
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { GenerateTestInput, GeneratedTest } from '../types';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export async function generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
  const {
    sonarIssue,
    patternSpec,
    symbol,
    existingTests,
    dependencies,
    codeAnalysis,
    memory,
  } = input;

  // ── Memory context — tells the LLM what NOT to repeat ────
  const memoryContext = memory
    ? `
PREVIOUS ATTEMPTS: ${memory.attemptCount}
STRATEGIES ALREADY TRIED — do NOT repeat any of these:
${memory.strategiesAttempted.map(s => `  - ${s}`).join('\n')}
LAST FAILURE REASON: ${memory.failureReason}

You MUST choose a strategy not in the list above.
    `.trim()
    : 'First attempt. Start with the most likely scenario (null input, guard clause, or happy path branch).';

  // ── Existing test examples ────────────────────────────────
  const existingTestsContext = existingTests.existingTests.length
    ? `EXISTING TESTS IN THIS CLASS — follow this naming style exactly:\n${
        existingTests.existingTests.map(t => `  - ${t}`).join('\n')
      }`
    : `No existing tests found. Use the naming convention: ${patternSpec.naming}`;

  // ── Dependency mock list ──────────────────────────────────
  const depsContext = dependencies.dependencies.length
    ? dependencies.dependencies
        .map(d => `  - Mock<${d.interface}> as ${d.mockName}`)
        .join('\n')
    : 'No constructor dependencies detected.';

  // ── Full prompt ───────────────────────────────────────────
  const prompt = `
You are a senior ${patternSpec.framework} test engineer for a .NET/Angular/React organisation.

Generate a SINGLE unit test that covers the following SonarQube issue:

TARGET
  File:   ${sonarIssue.file}
  Line:   ${sonarIssue.line}
  Method: ${symbol.class}.${symbol.method}

ORG TEST PATTERN — follow these exactly, no exceptions
  Framework:       ${patternSpec.framework}
  Mocking library: ${patternSpec.mocking}
  Assertion:       ${patternSpec.assertion}
  Structure:       ${patternSpec.pattern} (Arrange / Act / Assert — use comments)
  Naming:          ${patternSpec.naming}
  ${patternSpec.baseClass ? `Base class: inherit from ${patternSpec.baseClass}` : ''}
  ${patternSpec.utilities?.length ? `Utilities: ${patternSpec.utilities.join(', ')}` : ''}

${existingTestsContext}

CONSTRUCTOR DEPENDENCIES — set up ALL of these as mocks
${depsContext}

METHOD ANALYSIS
  Branches:          ${codeAnalysis.branches}
  Exception paths:   ${codeAnalysis.exceptions}
  Guard clauses:     ${codeAnalysis.guards.join('; ') || 'none'}
  Dependencies used in this method: ${codeAnalysis.dependenciesUsed.join(', ') || 'none'}

${memoryContext}

RULES — strictly enforced
1. Cover line ${sonarIssue.line} specifically — not just any line in the method
2. Include all necessary using/import statements so the test compiles
3. Name the test following EXACTLY: ${patternSpec.naming}
4. Use ${patternSpec.mocking} for all mocks — no other mocking library
5. Do NOT use [Fact] and [Theory] together — pick one
6. Return ONLY the test method — no class wrapper, no explanation, no markdown

Respond in this exact JSON format — no preamble, no backticks:
{
  "testName": "...",
  "strategy": "snake_case_label_under_20_chars",
  "code": "full test method source here including using statements"
}
`.trim();

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  // ── Parse response ────────────────────────────────────────
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const clean  = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean) as {
    testName: string;
    strategy: string;
    code:     string;
  };

  // Derive test file name from class name + language
  const ext      = sonarIssue.file.endsWith('.cs')  ? 'cs'
    : sonarIssue.file.endsWith('.tsx')               ? 'test.tsx'
    : 'spec.ts';
  const fileName = `${symbol.class}Tests.${ext}`;

  return {
    fileName,
    testName: parsed.testName,
    strategy: parsed.strategy,
    code:     parsed.code,
  };
}
