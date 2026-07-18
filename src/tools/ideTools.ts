// ─────────────────────────────────────────────────────────────
// @coverage agent — IDE / LSP Tools
// symbol_lookup · find_references · find_tests
//
// All three tools call VS Code's built-in LSP providers.
// They work for .NET (OmniSharp/Roslyn), Angular (TS server),
// and React (TS server) without any extra setup.
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path   from 'path';
import {
  SymbolLocation,
  FindReferencesOutput,
  FindTestsOutput,
} from '../types';

// ── symbol_lookup ───────────────────────────────────────────

export async function symbolLookup(
  file: string,
  line: number,
): Promise<SymbolLocation> {
  const uri      = vscode.Uri.file(file);
  const position = new vscode.Position(line - 1, 0);

  const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    uri,
    position,
  );

  if (!definitions?.length) {
    throw new Error(`symbol_lookup: no definition found at ${file}:${line}`);
  }

  const def  = definitions[0];
  const doc  = await vscode.workspace.openTextDocument(def.uri);
  const text = doc.lineAt(def.range.start.line).text.trim();

  // Extract method name: "public async Task<Order> CreateOrder(..."
  const methodMatch = text.match(/(?:async\s+)?[\w<>]+\s+(\w+)\s*\(/);
  const classMatch  = doc.getText().match(/class\s+(\w+)/);

  return {
    class:  classMatch?.[1]  ?? 'Unknown',
    method: methodMatch?.[1] ?? 'Unknown',
    file:   def.uri.fsPath,
    line:   def.range.start.line + 1,
  };
}

// ── find_references ─────────────────────────────────────────

export async function findReferences(
  symbol: SymbolLocation,
): Promise<FindReferencesOutput> {
  const uri      = vscode.Uri.file(symbol.file);
  const position = new vscode.Position(symbol.line - 1, 0);

  const refs = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    uri,
    position,
  );

  const references = (refs ?? []).map(r => ({
    callee:    path.basename(r.uri.fsPath),
    interface: 'Unknown', // enriched downstream by dependency_graph_analyze
  }));

  return { method: symbol.method, references };
}

// ── find_tests ──────────────────────────────────────────────

export async function findTests(
  symbol: SymbolLocation,
): Promise<FindTestsOutput> {
  // Search order: same method → same class → same class (spec) → any test file
  const patterns = [
    `**/*${symbol.method}*Test*`,
    `**/*${symbol.class}*Test*`,
    `**/*${symbol.class}*Spec*`,
    `**/*Tests*`,
  ];

  for (const pattern of patterns) {
    const files = await vscode.workspace.findFiles(
      pattern,
      '**/node_modules/**',
      5,
    );

    if (files.length === 0) { continue; }

    const testFiles: string[]    = files.map(f => f.fsPath);
    const existingTests: string[] = [];

    // Extract test method names from the first matched file
    const doc  = await vscode.workspace.openTextDocument(files[0]);
    const text = doc.getText();

    // .NET xUnit — [Fact] / [Theory] attribute above method
    const dotnetMatches = [
      ...text.matchAll(/\[(?:Fact|Theory)\]\s*\n\s*public[^(]+(\w+)\s*\(/g),
    ];
    dotnetMatches.forEach(m => existingTests.push(m[1]));

    // JS/TS — it('...') or test('...')
    const jsMatches = [...text.matchAll(/(?:it|test)\(['"`]([^'"`]+)/g)];
    jsMatches.forEach(m => existingTests.push(m[1]));

    return { testFiles, existingTests };
  }

  return { testFiles: [], existingTests: [] };
}
