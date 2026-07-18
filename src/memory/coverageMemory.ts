// ─────────────────────────────────────────────────────────────
// @coverage agent — Coverage Memory
// Persists attempt history per file+line to prevent
// the agent repeating the same failing strategy
// ─────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { CoverageMemoryRecord, BuildVerifyOutput } from '../types';

export class CoverageMemory {
  private readonly store: vscode.Memento;

  constructor(context: vscode.ExtensionContext) {
    // globalState persists across VS Code sessions
    this.store = context.globalState;
  }

  private key(file: string, line: number): string {
    return `coverage-memory:${file}:${line}`;
  }

  // ── coverage_memory.read ────────────────────────────────

  async read(file: string, line: number): Promise<CoverageMemoryRecord | null> {
    return this.store.get<CoverageMemoryRecord>(this.key(file, line)) ?? null;
  }

  // ── coverage_memory.write — after failed attempt ────────

  async writeFailure(
    file:     string,
    line:     number,
    strategy: string,
    result:   BuildVerifyOutput,
  ): Promise<void> {
    const existing = await this.read(file, line);

    const record: CoverageMemoryRecord = {
      file,
      line,
      attempted:           true,
      attemptCount:        (existing?.attemptCount ?? 0) + 1,
      failureReason:       result.failureReason ?? result.error ?? 'Unknown failure',
      strategiesAttempted: [...(existing?.strategiesAttempted ?? []), strategy],
      resolved:            false,
      escalate:            false,
    };

    await this.store.update(this.key(file, line), record);
  }

  // ── coverage_memory.write — on success ─────────────────

  async writeSuccess(file: string, line: number): Promise<void> {
    const existing = await this.read(file, line);

    const record: CoverageMemoryRecord = {
      ...(existing ?? {
        file, line, attempted: true, attemptCount: 1,
        failureReason: '', strategiesAttempted: [],
      }),
      resolved:  true,
      escalate:  false,
    } as CoverageMemoryRecord;

    await this.store.update(this.key(file, line), record);
  }

  // ── coverage_memory.write — on escalation ──────────────

  async writeEscalation(file: string, line: number): Promise<void> {
    const existing = await this.read(file, line);
    if (!existing) { return; }

    await this.store.update(this.key(file, line), {
      ...existing,
      escalate: true,
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  isEscalated(record: CoverageMemoryRecord | null): boolean {
    return record?.escalate === true;
  }

  hasTriedStrategy(record: CoverageMemoryRecord | null, strategy: string): boolean {
    return record?.strategiesAttempted.includes(strategy) ?? false;
  }
}
