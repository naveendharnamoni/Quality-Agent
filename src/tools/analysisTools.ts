// ─────────────────────────────────────────────────────────────
// @coverage agent — Analysis Tools
// dependency_graph_analyze · target_code_analyze
//
// Both tools operate on the symbol level — never the whole file.
// This keeps context size small in large .NET solutions.
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import {
  SymbolLocation,
  DependencyGraphOutput,
  TargetCodeOutput,
} from '../types';

// ── dependency_graph_analyze ────────────────────────────────
//
// Extracts constructor-level dependencies.
// Missing or wrong mock setup is the #1 cause of failed
// AI-generated tests — so this runs before generate_test.

export async function dependencyGraphAnalyze(
  symbol: SymbolLocation,
): Promise<DependencyGraphOutput> {
  const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.file));
  const text = doc.getText();

  // Match constructor params — JS/TS first, then C#
  const ctorMatch =
    text.match(/constructor\s*\(([^)]+)\)/s) ??   // JS/TS
    text.match(/public\s+\w+\s*\(([^)]+)\)/s);     // C#

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

    // TS: "private repository: IRepository"
    const tsMatch = trimmed.match(/(?:private\s+)?(\w+)\s*:\s*(I\w+)/);
    if (tsMatch) {
      dependencies.push({
        interface: tsMatch[2],
        mockName:  `_${tsMatch[1]}`,
      });
    }
  }

  return { dependencies };
}

// ── target_code_analyze ─────────────────────────────────────
//
// Analyses only the target method body — not the whole file.
// Extracts branches, guards, exceptions, and which injected
// dependencies are actually invoked in this method.

export async function targetCodeAnalyze(
  symbol: SymbolLocation,
): Promise<TargetCodeOutput> {
  const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.file));
  const text = doc.getText();

  const methodStart = text.indexOf(`${symbol.method}(`);
  if (methodStart === -1) {
    throw new Error(`target_code_analyze: method "${symbol.method}" not found in ${symbol.file}`);
  }

  // Walk braces to extract the method body only
  let depth = 0, started = false, methodBody = '';
  for (let i = methodStart; i < text.length; i++) {
    if (text[i] === '{') { depth++;  started = true; }
    if (text[i] === '}') { depth--; }
    methodBody += text[i];
    if (started && depth === 0) { break; }
  }

  const branches   = (methodBody.match(/\bif\b|\belse\b|\bswitch\b|\bcase\b|\?\?|\?\./g) ?? []).length;
  const exceptions = (methodBody.match(/\bthrow\b|\bcatch\b/g) ?? []).length;
  const guards     = [...methodBody.matchAll(/if\s*\(([^)]+)\)\s*throw/g)]
    .map(m => m[0].trim());

  // Detect which injected deps are actually called in this method
  const knownDeps      = ['repository', 'mapper', 'cache', 'logger', 'eventBus', 'service'];
  const dependenciesUsed = knownDeps.filter(d =>
    new RegExp(`_?${d}\\s*[.(]`, 'i').test(methodBody),
  );

  return {
    method: symbol.method,
    branches,
    exceptions,
    guards,
    targetLine:       symbol.line,
    dependenciesUsed,
  };
}
