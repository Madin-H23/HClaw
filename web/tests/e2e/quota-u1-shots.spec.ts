/**
 * U1 额度面板信息设计升级 —— mock 驱动多状态截图脚本（入库可复跑）
 *
 * 走仓库 Playwright 配置（web/playwright.config.ts），从仓库根运行：
 *   QUOTA_SHOTS=1 npx playwright test -c web/playwright.config.ts web/tests/e2e/quota-u1-shots.spec.ts
 * （webServer 钩子自动起 vite dev；未设 QUOTA_SHOTS 时全部用例跳过。）
 *
 * 产物：docs/screenshots/u1/*.png —— 覆盖新汇总行（总数+四档色点分布+最紧
 * 点名）、炉心温度计表盘多档位（充足/紧张/临界/耗尽/美元余额/虚线降级）、
 * 窗口折叠默认态与展开态、全池无快照 / 未配置 / 陈旧降级。
 * T7 基线截图（docs/screenshots/t7）保持不动，作升级前对照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

function repoRoot(): string {
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

const OUT_DIR = path.join(repoRoot(), 'docs', 'screenshots', 'u1');
const SHOTS_ENABLED = process.env.QUOTA_SHOTS === '1';
const HARNESS = '/tests/e2e/quota-harness.html';

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

test('U1 面板：汇总行 + 炉心温度计多档位（折叠默认态）', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'all-tiers', '01-u1-panel-summary-dials.png');
  // 汇总行：总数 + 四档计数 + 最紧点名
  const summary = page.getByTestId('quota-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('7 家供应商');
  await expect(summary).toContainText('最紧：火山方舟');
  // 表盘：多档位与降级形态并存
  await expect(
    page.locator('[data-testid="quota-gauge-arc"]').first(),
  ).toBeVisible();
  // 折叠默认态：MiniMax AB 只展示最紧的「月度包」
  const minimax = page.getByTestId('quota-card-minimax-ab');
  await expect(minimax).toContainText('月度包');
  await expect(minimax).not.toContainText('5h 窗口');
});

test('U1 面板：窗口明细展开态', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.goto(`${HARNESS}?view=panel&state=all-tiers`);
  await page.waitForSelector('[data-testid="quota-card-minimax-ab"]', {
    timeout: 15_000,
  });
  await page.waitForTimeout(300);
  const toggle = page
    .getByTestId('quota-card-minimax-ab')
    .getByTestId('quota-windows-toggle');
  await expect(toggle).toContainText('展开其余 2 窗');
  await toggle.click();
  await expect(toggle).toContainText('收起窗口明细');
  const minimax = page.getByTestId('quota-card-minimax-ab');
  await expect(minimax).toContainText('5h 窗口');
  await expect(minimax).toContainText('周窗口');
  await page.waitForTimeout(200);
  await page.screenshot({
    path: `${OUT_DIR}/02-u1-panel-window-expanded.png`,
    fullPage: true,
  });
});

test('U1 面板：全池无快照（汇总行降级 + 虚线表盘）', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'all-missing', '03-u1-panel-all-missing.png');
  await expect(page.getByTestId('quota-summary')).toContainText('暂无档位数据');
  await expect(page.getByText('暂无额度数据').first()).toBeVisible();
});

test('U1 面板：陈旧数据标注（表盘照常呈现）', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'stale', '04-u1-panel-stale.png');
  await expect(page.getByText('数据已过期')).toBeVisible();
});

test('U1 面板：未配置额度源（汇总行静默形态 + 横幅）', async ({ page }) => {
  test.skip(!SHOTS_ENABLED, '截图脚本仅在显式 QUOTA_SHOTS=1 时运行');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await shootPanel(page, 'unconfigured', '05-u1-panel-unconfigured.png');
  await expect(page.getByTestId('quota-summary')).toContainText(
    '尚未配置额度源映射',
  );
  await expect(page.getByTestId('quota-unconfigured')).toBeVisible();
});
