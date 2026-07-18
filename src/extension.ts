// ─────────────────────────────────────────────────────────────
// @coverage agent — Extension Entry Point
// Registers the Chat Participant (@coverage) and
// the approve/reject commands for human-in-the-loop
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as fs     from 'fs/promises';
import * as path   from 'path';
import { CoverageAgent } from './agent/coverageAgent';

export function activate(context: vscode.ExtensionContext) {

  // ── Register @coverage Chat Participant ──────────────────

  const participant = vscode.chat.createChatParticipant(
    'coverage',
    async (
      request: vscode.ChatRequest,
      _ctx:    vscode.ChatContext,
      stream:  vscode.ChatResponseStream,
      token:   vscode.CancellationToken,
    ) => {
      // Parse args: @coverage projectKey=order-api branch=develop
      const args        = parseArgs(request.prompt);
      const projectKey  = args.projectKey ?? '';
      const branch      = args.branch     ?? 'main';

      if (!projectKey) {
        stream.markdown(
          '**Usage:** `@coverage projectKey=<your-sonar-project-key> branch=<branch-name>`\n\n'
          + 'Example: `@coverage projectKey=order-api branch=develop`',
        );
        return;
      }

      const agent = new CoverageAgent(context);

      try {
        await agent.run(stream, projectKey, branch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stream.markdown(`❌ **Error:** ${message}`);
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon('shield');

  // ── Register approve command ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coverage.approveTest',
      async (generated: { fileName: string; testName: string; code: string }) => {
        await applyGeneratedTest(generated);
        vscode.window.showInformationMessage(
          `✅ Test applied: ${generated.testName}`,
        );
      },
    ),
  );

  // ── Register reject command ──────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coverage.rejectTest',
      async (generated: { fileName: string; testName: string }) => {
        vscode.window.showInformationMessage(
          `❌ Test rejected: ${generated.testName}`,
        );
      },
    ),
  );

  context.subscriptions.push(participant);
}

export function deactivate() {}

// ── Apply test to the workspace ──────────────────────────────

async function applyGeneratedTest(generated: {
  fileName: string;
  testName: string;
  code:     string;
}): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    throw new Error('No workspace folder open');
  }

  // Find the test file — or create it if it doesn't exist
  const testFiles = await vscode.workspace.findFiles(
    `**/${generated.fileName}`,
    '**/node_modules/**',
    1,
  );

  if (testFiles.length > 0) {
    // Append to existing test file — before the last closing brace
    const filePath  = testFiles[0].fsPath;
    const existing  = await fs.readFile(filePath, 'utf-8');
    const lastBrace = existing.lastIndexOf('}');
    const updated   =
      existing.slice(0, lastBrace)
      + '\n\n'
      + indent(generated.code, 4)
      + '\n'
      + existing.slice(lastBrace);

    await fs.writeFile(filePath, updated, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  } else {
    // Create a new test file
    const testDir  = path.join(workspaceRoot, 'Tests');
    const filePath = path.join(testDir, generated.fileName);

    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(filePath, generated.code, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function parseArgs(prompt: string): Record<string, string> {
  const args: Record<string, string> = {};
  const matches = prompt.matchAll(/(\w+)=([^\s]+)/g);
  for (const m of matches) { args[m[1]] = m[2]; }
  return args;
}

function indent(code: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return code.split('\n').map(l => pad + l).join('\n');
}
