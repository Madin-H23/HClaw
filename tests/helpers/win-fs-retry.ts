import fs from 'node:fs';

/**
 * Windows 并行全量跑的文件系统抖动缓解（issue #17）。
 *
 * 本机实测根因：AV/索引器（Lenovo Anti-Virus/火绒内核实时扫描、
 * SearchIndexer）在文件刚关闭的瞬间短暂持有句柄，写路径的原子 rename
 * （tmp → 目标）会以 EPERM 偶发失败；句柄释放后重试即成功。Linux CI
 * 无此问题。先例：T6 在 tests/quota-router-assembly-injection.test.ts
 * 内联过同款 saveWithRetry，这里抽成共享 helper 供各夹具复用。
 *
 * 重试耗尽后如实抛出——不吞错、不降级断言、不 skip。
 */

const FS_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 对同步/异步落盘操作做 EPERM/EACCES/EBUSY/ENOTEMPTY 退避重试。 */
export async function withFsRetry<T>(
  op: () => T,
  attempts = 5,
  delayMs = 50,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !FS_RETRYABLE_CODES.has(code)) {
        throw err;
      }
      await delay(delayMs);
    }
  }
}

/**
 * 临时目录清理专用：先关闭测试持有的 SQLite 句柄（db.closeDatabase()）
 * 再调用。除 AV/索引器抖动外，Windows 句柄刚释放后的 delete-pending
 * 窗口也会让 rmSync 报 EPERM/ENOTEMPTY，小退避重试即可恢复。
 */
export async function rmTempDirWithRetry(
  dir: string,
  attempts = 6,
  delayMs = 50,
): Promise<void> {
  await withFsRetry(
    () => fs.rmSync(dir, { recursive: true, force: true }),
    attempts,
    delayMs,
  );
}
