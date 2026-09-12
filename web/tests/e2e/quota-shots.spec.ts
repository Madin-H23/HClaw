/**
 * T7 额度面板 / 提示卡片 —— mock 驱动多状态截图脚本（入库可复跑）
 *
 * 走仓库 Playwright 配置（web/playwright.config.ts），从仓库根运行：
 *   QUOTA_SHOTS=1 npx playwright test -c web/playwright.config.ts web/tests/e2e/quota-shots.spec.ts
 * （webServer 钩子会自动起 vite dev；未设 QUOTA_SHOTS 时全部用例跳过，
 *   不干扰常规 e2e。）
 *
 * 产物：docs/screenshots/t7/*.png —— 覆盖面板四档齐全 / missing 降级 /
 * 陈旧标注 / 未配置横幅 / 加载骨架 + 三种会话内提示卡片与会话流全景。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

// 产物固定落仓库根 docs/screenshots/t7（与 cwd 无关：playwright 规范跑法是
// web/ 目录下 `npm run test:e2e`，本文件位于 web/tests/e2e/）
function repoRoot(): string {
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

const OUT_DIR = path.join(repoRoot(), 'docs', 'screenshots', 't7');
const SHOTS_ENABLED = process.env.QUOTA_SHOTS === '1';
const HARNESS = '/tests/e2e/quota-harness.html';

// 桌面视口：面板网格与卡片气泡的主流使用形态
test.use({ viewport: { width: 1280, height: 860 } });

async function shootPanel(page: Page, state: string, file: string) {
  await page.goto(`${HARNESS}?view=panel&state=${state}`);
  await page.waitForSelector(
    '[data-testid^="quota-card-"], [data-testid="quota-loading"]',
    { timeout: 15_000 },
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}/${file}`, fullPage: true });
}

test('面板：四档档位齐全（含三类原始信号）', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'all-tiers', '01-panel-all-tiers.png');
  await expect(page.getByText('充足').first()).toBeVisible();
  await expect(page.getByText('耗尽').first()).toBeVisible();
});

test('面板：含映射缺失与无快照降级', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'missing', '02-panel-missing.png');
  await expect(page.getByText('未配置额度源')).toBeVisible();
  await expect(page.getByText('暂无额度数据').first()).toBeVisible();
});

test('面板：含陈旧数据标注', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'stale', '03-panel-stale.png');
  await expect(page.getByText('数据已过期')).toBeVisible();
});

test('面板：未配置额度源横幅', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'unconfigured', '04-panel-unconfigured.png');
  await expect(page.getByTestId('quota-unconfigured')).toBeVisible();
});

test('面板：加载骨架屏', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.goto(`${HARNESS}?view=panel&state=loading`);
  await page.waitForSelector('[data-testid="quota-loading"]', {
    timeout: 15_000,
  });
  await page.screenshot({ path: `${OUT_DIR}/05-panel-loading.png` });
});

const CARD_CASES: Array<{ kind: string; file: string; badge: string }> = [
  { kind: 'downgrade', file: '06-card-downgrade.png', badge: '【额度降档】' },
  { kind: 'veto', file: '07-card-veto.png', badge: '【额度否决】' },
  { kind: 'allow', file: '08-card-override-allow.png', badge: '【额度放行】' },
];

for (const { kind, file, badge } of CARD_CASES) {
  test(`卡片：${badge}会话流内渲染`, async ({ page }) => {
    test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.goto(`${HARNESS}?view=cards&cards=${kind}`);
    await page.waitForSelector(`text=${badge}`, { timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT_DIR}/${file}`, fullPage: true });
  });
}

test('卡片：三种事件卡片会话流全景', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.goto(`${HARNESS}?view=cards&cards=all`);
  await page.waitForSelector('text=【额度放行】', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${OUT_DIR}/09-cards-in-conversation.png`,
    fullPage: true,
  });
});
