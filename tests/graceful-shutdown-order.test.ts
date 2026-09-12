import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Windows 适配（#11）：core.autocrlf=true 检出使工作区源码为 CRLF，而断言以
// LF 文本为基准（跨行 needle）。读取后归一为 LF；POSIX 检出无 \r，为 no-op。
const readSourceLf = (file: string) =>
  fs
    .readFileSync(path.join(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n');

describe('graceful shutdown lifecycle order', () => {
  test('stops intake and agents, terminalizes cards, then disconnects IM', () => {
    const source = readSourceLf('src/index.ts');
    const shutdownStart = source.indexOf(
      'const shutdown = async (signal: string)',
    );
    const shutdownEnd = source.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdown = source.slice(shutdownStart, shutdownEnd);

    const rejectIntake = shutdown.indexOf('shuttingDown = true');
    const pauseInbound = shutdown.indexOf('imManager.pauseInbound()');
    const stopWeb = shutdown.indexOf('shutdownWebServer()');
    const stopAgents = shutdown.indexOf('queue\n        .shutdown(15_000)');
    const finalizeCards = shutdown.indexOf(
      "abortAllStreamingSessions('服务维护中')",
    );
    const disconnectIm = shutdown.indexOf('imManager\n      .disconnectAll()');

    for (const index of [
      rejectIntake,
      pauseInbound,
      stopWeb,
      stopAgents,
      finalizeCards,
      disconnectIm,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(rejectIntake).toBeLessThan(stopWeb);
    expect(rejectIntake).toBeLessThan(stopAgents);
    expect(rejectIntake).toBeLessThan(pauseInbound);
    expect(pauseInbound).toBeLessThan(stopWeb);
    expect(stopWeb).toBeLessThan(finalizeCards);
    expect(stopAgents).toBeLessThan(finalizeCards);
    expect(finalizeCards).toBeLessThan(disconnectIm);

    // A timeout race would reintroduce the disconnect-vs-finalize bug: the
    // abort promise would keep running after the transport had been closed.
    const cardPhase = shutdown.slice(finalizeCards, disconnectIm);
    expect(cardPhase).not.toContain('Promise.race');
  });
});
