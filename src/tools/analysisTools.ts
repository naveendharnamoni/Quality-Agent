// ─────────────────────────────────────────────────────────────
// @coverage agent — Analysis Tools
// dependency_graph_analyze · target_code_analyze
//
// These two tools have no VS Code built-in or MCP equivalent.
// They operate at the symbol level — never loading the whole
// file — to keep context size small in large .NET solutions.
//
// dependency_graph_analyze: constructor param extraction.
//   Missing mock setup is the #1 cause of failed AI-generated
//   tests, so this always runs before generate_test.
//
// target_code_analyze: method body extraction only.
//   Counts branches, exceptions, guards, and which injected
//   dependencies are actually called in this method.
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  SymbolLocation,
  DependencyGraphOutput,
  TargetCodeOutput,
} from '../types';

// ── dependency_graph_analyze ─────────────────────────────────

export async function dependencyGraphAnalyze(
  symbol: SymbolLocation,
): Promise<DependencyGraphOutput> {
  const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.file));
  const text = doc.getText();

  // Match constructor params — JS/TS first, then C#
  const ctorMatch =
    text.match(/constructor\s*\(([^)]+)\)/s) ??  // TS/Angular/React
    text.match(/public\s+\w+\s*\(([^)]+)\)/s);   // C# constructor

  const dependencies: Array<{ interface: string; mockName: string }> = [];

  if (!ctorMatch) {
    return { dependencies };
  }

  for (const param of ctorMatch[1].split(',')) {
    const trimmed = param.trim();

    // C#: "IRepository<Order> repository" or "ILogger<T> _logger"
    const csMatch = trimmed.match(/^(I\w+(?:<[^>]+>)?)\s+(\w+)$/);
    if (csMatch) {
      dependencies.push({
        interface: csMatch[1],
        mockName:  csMatch[2].startsWith('_') ? csMatch[2] : `_${csMatch[2]}`,
      });
      continue;
    }

    // TS: "private repository: IRepository" or "private readonly repo: IRepo"
    const tsMatch = trimmed.match(/(?:private\s+(?:readonly\s+)?)?(\w+)\s*:\s*(I\w+)/);
    if (tsMatch) {
      dependencies.push({
        interface: tsMatch[2],
        mockName:  `_${tsMatch[1]}`,
      });
    }
  }

  return { dependencies };
}

// ── target_code_analyze ──────────────────────────────────────

export async function targetCodeAnalyze(
  symbol: SymbolLocation,
): Promise<TargetCodeOutput> {
  const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.file));
  const text = doc.getText();

  const methodStart = text.indexOf(`${symbol.method}(`);
  if (methodStart === -1) {
    throw new Error(
      `target_code_analyze: method "${symbol.method}" not found in ${symbol.file}`,
    );
  }

  // Walk braces to extract ONLY the method body — not the whole file
  let depth = 0, started = false, methodBody = '';
  for (let i = methodStart; i < text.length; i++) {
    if (text[i] === '{') { depth++;  started = true; }
    if (text[i] === '}') { depth--; }
    methodBody += text[i];
    if (started && depth === 0) { break; }
  }

  const branches = (
    methodBody.match(/\bif\b|\belse\b|\bswitch\b|\bcase\b|\?\?|\?\./g) ?? []
  ).length;

  const exceptions = (
    methodBody.match(/\bthrow\b|\bcatch\b/g) ?? []
  ).length;

  const guards = [...methodBody.matchAll(/if\s*\(([^)]+)\)\s*throw/g)]
    .map(m => m[0].trim());

  // Detect which injected dependencies are actually invoked in this method
  // Covers both _repository.Method() and this._repository.Method() patterns
  const knownDeps      = ['repository', 'mapper', 'cache', 'logger', 'eventBus', 'service'];
  const dependenciesUsed = knownDeps.filter(d =>
    new RegExp(`(?:this\\.)?_?${d}\\s*[.(]`, 'i').test(methodBody),
  );

  return {
    method:           symbol.method,
    branches,
    exceptions,
    guards,
    targetLine:       symbol.line,
    dependenciesUsed,
  };
}
