// ─────────────────────────────────────────────────────────────
// @coverage agent — IDE / LSP Tools
// symbol_lookup · find_references · find_tests
//
// UPDATED from previous version:
//   find_references → now uses prepareCallHierarchy +
//     provideIncomingCalls (purpose-built for call graphs,
//     returns structured CallerInfo instead of raw Location[])
//   find_tests → delegates file search + text scan to
//     VS Code built-in workspace APIs (same as Copilot
//     #search/fileSearch + #search/textSearch internally)
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  SymbolLocation,
  FindReferencesOutput,
  CallerInfo,
  FindTestsOutput,
} from '../types';

// ── symbol_lookup ────────────────────────────────────────────
// Uses vscode.executeDefinitionProvider to locate the symbol,
// then vscode.executeDocumentSymbolProvider to extract the
// class name from the document symbol tree.

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

  const def = definitions[0];
  const doc = await vscode.workspace.openTextDocument(def.uri);

  // Use document symbol provider for accurate class + method extraction
  // instead of regex on raw text
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    def.uri,
  );

  let className  = 'Unknown';
  let methodName = 'Unknown';

  if (symbols) {
    for (const sym of symbols) {
      if (sym.kind === vscode.SymbolKind.Class) {
        className = sym.name;
        const child = sym.children.find(
          c => c.range.contains(def.range.start),
        );
        if (child) { methodName = child.name; }
      }
    }
  }

  // Fallback to text parsing if LSP symbols unavailable
  if (methodName === 'Unknown') {
    const text        = doc.lineAt(def.range.start.line).text.trim();
    const methodMatch = text.match(/(?:async\s+)?[\w<>]+\s+(\w+)\s*\(/);
    const classMatch  = doc.getText().match(/class\s+(\w+)/);
    methodName = methodMatch?.[1] ?? 'Unknown';
    className  = classMatch?.[1]  ?? 'Unknown';
  }

  return {
    class:  className,
    method: methodName,
    file:   def.uri.fsPath,
    line:   def.range.start.line + 1,
  };
}

// ── find_references ──────────────────────────────────────────
// UPGRADED: uses Call Hierarchy API instead of executeReferenceProvider.
// prepareCallHierarchy + provideIncomingCalls returns structured
// CallerInfo — who calls this method and from which class.
// This is directly what the LLM needs to determine what to mock.

export async function findReferences(
  symbol: SymbolLocation,
): Promise<FindReferencesOutput> {
  const uri      = vscode.Uri.file(symbol.file);
  const position = new vscode.Position(symbol.line - 1, 0);

  // Step 1: prepare call hierarchy item for the target method
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy',
    uri,
    position,
  );

  if (!items?.length) {
    return { method: symbol.method, callers: [] };
  }

  // Step 2: get incoming calls — who calls this method
  const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
    'vscode.provideIncomingCalls',
    items[0],
  );

  const callers: CallerInfo[] = (incomingCalls ?? []).map(call => {
    // Extract interface from caller name — convention: ISomething
    const interfaceMatch = call.from.name.match(/I[A-Z]\w+/);

    return {
      callerClass:  call.from.detail ?? 'Unknown',
      callerMethod: call.from.name,
      interface:    interfaceMatch?.[0] ?? call.from.detail ?? 'Unknown',
    };
  });

  return { method: symbol.method, callers };
}

// ── find_tests ───────────────────────────────────────────────
// Uses VS Code built-in workspace.findFiles (same underlying
// mechanism as Copilot #search/fileSearch).
// Searches in priority order: method → class → spec → any tests.
// Extracts test names via regex for both .NET and JS/TS.

export async function findTests(
  symbol: SymbolLocation,
): Promise<FindTestsOutput> {
  const searchPatterns = [
    `**/*${symbol.method}*Test*`,    // most specific first
    `**/*${symbol.class}*Test*`,
    `**/*${symbol.class}*Spec*`,
    `**/*Tests*`,
  ];

  for (const pattern of searchPatterns) {
    const files = await vscode.workspace.findFiles(
      pattern,
      '**/node_modules/**',
      5,
    );

    if (files.length === 0) { continue; }

    const testFiles     = files.map(f => f.fsPath);
    const existingTests: string[] = [];

    const doc  = await vscode.workspace.openTextDocument(files[0]);
    const text = doc.getText();

    // .NET xUnit — [Fact] / [Theory] attribute
    [...text.matchAll(/\[(?:Fact|Theory)\]\s*\n\s*public[^(]+(\w+)\s*\(/g)]
      .forEach(m => existingTests.push(m[1]));

    // JS/TS Jest/Jasmine — it('...') / test('...')
    [...text.matchAll(/(?:it|test)\(['"`]([^'"`]+)/g)]
      .forEach(m => existingTests.push(m[1]));

    return { testFiles, existingTests };
  }

  return { testFiles: [], existingTests: [] };
}
