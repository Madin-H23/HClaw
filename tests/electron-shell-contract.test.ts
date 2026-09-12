import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const mainSource = readFileSync(
  resolve(projectRoot, 'electron/src/main/index.ts'),
  'utf8',
);
const preloadSource = readFileSync(
  resolve(projectRoot, 'electron/src/preload/index.ts'),
  'utf8',
);
const builderConfig = readFileSync(
  resolve(projectRoot, 'electron/electron-builder.yml'),
  'utf8',
);

describe('Electron Desktop Shell contract', () => {
  it('keeps privileged capabilities in Main and exposes a narrow Preload bridge', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain("ipcMain.handle('desktop:open-external'");
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld');
    expect(preloadSource).not.toContain('fs');
    expect(preloadSource).not.toContain('child_process');
  });

  it('keeps packaging focused on the desktop shell', () => {
    // T1 品牌浅改（ADR-0005，票面指令）：productName 由 Miniclaw 改为 HClaw，
    // 测试意图不变（打包聚焦桌面壳、图标与产物目录不动）。
    // T8 内嵌打包（ADR-0007，票面指令）：打包根由 electron/ 改仓库根，图标
    // 路径随打包根加 electron/ 前缀（打包域调整，意图仍聚焦产物目录不动）。
    expect(builderConfig).toContain('productName: HClaw');
    expect(builderConfig).toContain('icon: electron/assets/miniclaw-icon.png');
    expect(builderConfig).toContain('icon: electron/assets/miniclaw.icns');
    expect(builderConfig).toContain('assets/**/*');
    expect(builderConfig).toContain('dist/**/*');
    expect(builderConfig).toContain('extraMetadata:');
  });
});
