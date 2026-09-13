// UI-U2 全局动效系统测钉（路由过渡 / 消息入场 / 滚动锚定 / reduced-motion）。
// 走仓库 Playwright 配置（web/playwright.config.ts），从仓库根运行：
//   npx playwright test -c web/playwright.config.ts web/tests/e2e/u2-motion.spec.ts
// 截图证据（U2_SHOTS=1）产出 docs/screenshots/u2/。
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_HARNESS = '/tests/e2e/u2-route-harness.html';
const MOTION_HARNESS = '/tests/e2e/u2-motion-harness.html';

// 注意：不要在移动仿真上下文中途 setViewportSize——DOM 保留但渲染面会变白
// （Chromium 合成问题，实测复现）；桌面尺寸截图一律用独立视口上下文。

/** MessageList 的滚动容器（harness 页内唯一的 h-full overflow-y-auto）。 */
function scroller(page: Page) {
  return page.locator('div.h-full.overflow-y-auto');
}

test.describe('路由切换入场过渡', () => {
  test('keyed 容器随路由重挂载携带 hc-enter-up，min-h-full 与滚动语义不破', async ({
    page,
  }) => {
    await page.goto(`${ROUTE_HARNESS}?start=%2Ftasks`);
    const main = page.locator('[data-app-scroll-root]');
    await expect(page.locator('[data-u2-stub="任务"]')).toBeVisible();

    // 1) wrapper 存在且声明了入场动画（motion-normal 档）
    const wrapper = main.locator('> .hc-enter-page');
    await expect(wrapper).toHaveCount(1);
    await expect(wrapper).toHaveCSS('animation-name', 'hc-enter-up');

    // 2) h-full 包裹层不破坏 tall 页面滚动（scrollHeight > clientHeight）
    await expect
      .poll(async () =>
        main.evaluate((el) => el.scrollHeight > el.clientHeight),
      )
      .toBe(true);

    // 3) 滚动后导航：stub 换新、wrapper 重新携带入场类
    await main.evaluate((el) => {
      el.scrollTop = 400;
    });
    await page.evaluate(() =>
      (
        window as unknown as { __u2Navigate: (to: string) => void }
      ).__u2Navigate('/memory'),
    );
    await expect(page.locator('[data-u2-stub="记忆"]')).toBeVisible();
    await expect(page.locator('[data-u2-stub="任务"]')).toHaveCount(0);
    await expect(wrapper).toHaveCount(1);
    await expect(wrapper).toHaveCSS('animation-name', 'hc-enter-up');

    // 4) min-h-full 解析基准未被包裹层破坏：stub 高度 = wrapper 高度
    //    （wrapper h-full = main 内容盒高度，与改造前页面直挂 main 同基准，
    //    差值即 BottomTabBar/安全区留白，两端一致即可）
    const [stubHeight, wrapperHeight] = await page
      .locator('[data-u2-stub="记忆"]')
      .evaluate((el) => {
        const wrapper = el.parentElement;
        return [
          el.getBoundingClientRect().height,
          wrapper ? wrapper.getBoundingClientRect().height : 0,
        ];
      });
    expect(wrapperHeight).toBeGreaterThan(0);
    expect(Math.abs(stubHeight - wrapperHeight)).toBeLessThan(1);
  });

  test('prefers-reduced-motion 下路由入场动画关闭', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${ROUTE_HARNESS}?start=%2Fmemory`);
    await expect(page.locator('[data-u2-stub="记忆"]')).toBeVisible();
    await expect(
      page.locator('[data-app-scroll-root] > .hc-enter-page'),
    ).toHaveCSS('animation-name', 'none');
  });
});

test.describe('消息入场动画与滚动锚定', () => {
  test('历史不动画；新消息入场且自动滚回底部', async ({ page }) => {
    await page.goto(MOTION_HARNESS);
    const list = scroller(page);
    await expect(page.getByText('历史消息 30')).toBeVisible();

    // 历史灌入不播入场动画
    await expect(page.locator('.hc-enter-card')).toHaveCount(0);

    // 初始已锚定在底部
    await expect
      .poll(async () =>
        list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThan(10);

    // 追加新消息：入场类 + hc-enter-up 动画
    await page.evaluate(() =>
      (window as unknown as { __u2Append: () => void }).__u2Append(),
    );
    await expect(page.locator('.hc-enter-card')).toHaveCount(1);
    await expect(page.locator('.hc-enter-card')).toHaveCSS(
      'animation-name',
      'hc-enter-up',
    );
    await expect(page.locator('.hc-enter-card')).toContainText('新消息 31');

    // 自动滚动把新消息带回视口底部（锚定不破）
    await page.waitForTimeout(1200);
    await expect
      .poll(async () =>
        list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThan(10);
  });

  test('入场动画不改变布局度量（虚拟列表锚定不被扰动）', async ({ page }) => {
    await page.goto(MOTION_HARNESS);
    const list = scroller(page);
    await expect(page.getByText('历史消息 30')).toBeVisible();
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);

    // 追加新消息：滚动容器高度会增长一条消息（正常），但「动画进行中」
    // 与「动画结束后」的布局度量必须完全一致——transform/opacity 不参与
    // 布局，入场动画才不会抖动虚拟列表与滚动锚定。
    await page.evaluate(() =>
      (window as unknown as { __u2Append: () => void }).__u2Append(),
    );
    await expect(page.locator('.hc-enter-card')).toHaveCount(1);
    const during = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      itemH: el.querySelector('.hc-enter-card')?.getBoundingClientRect().height,
    }));
    await page.waitForTimeout(400);
    const after = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      itemH: el.querySelector('.hc-enter-card')?.getBoundingClientRect().height,
    }));

    expect(after.scrollHeight).toBe(during.scrollHeight);
    expect(after.itemH).toBe(during.itemH);
  });

  test('prefers-reduced-motion 下消息入场动画关闭', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(MOTION_HARNESS);
    await expect(page.getByText('历史消息 30')).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __u2Append: () => void }).__u2Append(),
    );
    await expect(page.locator('.hc-enter-card')).toHaveCount(1);
    await expect(page.locator('.hc-enter-card')).toHaveCSS(
      'animation-name',
      'none',
    );
  });
});

// 截图证据（入库可复跑）：U2_SHOTS=1 时产出 docs/screenshots/u2/。
// 仓库根判定：从 cwd 向上找 CI workflow 标记（Playwright 转译会重写模块
// URL，__dirname/import.meta.url 推导在 Windows 下不可靠，U1 实测走 cwd）。
function repoRoot(): string {
  let dir = process.cwd();
  while (
    dir !== path.dirname(dir) &&
    !fs.existsSync(path.join(dir, '.github', 'workflows', 'hclaw-ci.yml'))
  ) {
    dir = path.dirname(dir);
  }
  return dir;
}

test.describe('U2 截图证据（U2_SHOTS=1 时运行，入库可复跑）', () => {
  // 桌面视口上下文：路由过渡页。test.use 作用域=所在 describe，
  // 桌面/移动拆嵌套子作用域，避免 viewport 配置互相覆盖。
  test.describe('桌面', () => {
    test.use({ viewport: { width: 1280, height: 860 } });
    test('路由过渡页（stub + 炉心侧栏）', async ({ page }) => {
      test.skip(process.env.U2_SHOTS !== '1', '截图仅在显式 U2_SHOTS=1 时运行');
      const outDir = path.join(repoRoot(), 'docs', 'screenshots', 'u2');
      fs.mkdirSync(outDir, { recursive: true });
      await page.goto(`${ROUTE_HARNESS}?start=%2Ftasks`);
      await expect(page.locator('[data-u2-stub="任务"]')).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${outDir}/01-route-transition-tasks.png`,
        fullPage: false,
      });
    });

    test('任务页统计行分组徽标', async ({ page }) => {
      test.skip(process.env.U2_SHOTS !== '1', '截图仅在显式 U2_SHOTS=1 时运行');
      const outDir = path.join(repoRoot(), 'docs', 'screenshots', 'u2');
      fs.mkdirSync(outDir, { recursive: true });
      await page.goto('/tests/e2e/u2-tasks-harness.html');
      await expect(
        page.getByText('定时任务管理', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel('任务统计').getByText('已启用'),
      ).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `${outDir}/05-tasks-stats-chips.png`,
        fullPage: false,
      });
    });
  });

  // 消息流截图保留项目默认移动视口——虚拟列表在桌面仿真视口下会触发
  // 「DOM 在但渲染面全白」的合成问题（探针实测），移动视口渲染正常，
  // 且与产品实际移动形态一致。harness 同步种子消息的初始锚底与真实异步
  // 加载路径存在竞态，截图前显式锚底（功能性行为由上方 5 个测钉保证）。
  test.describe('移动', () => {
    test('新消息入场与滚动锚定', async ({ page }) => {
      test.skip(process.env.U2_SHOTS !== '1', '截图仅在显式 U2_SHOTS=1 时运行');
      const outDir = path.join(repoRoot(), 'docs', 'screenshots', 'u2');
      fs.mkdirSync(outDir, { recursive: true });
      const list = page.locator('div.h-full.overflow-y-auto');
      await page.goto(MOTION_HARNESS);
      await expect(page.getByText('历史消息 30')).toBeVisible();
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${outDir}/02-message-history-anchored.png`,
        fullPage: false,
      });
      await page.evaluate(() =>
        (window as unknown as { __u2Append: () => void }).__u2Append(),
      );
      await expect(page.locator('.hc-enter-card')).toHaveCount(1);
      // 动画进行中截一张（150ms 入场窗口内）
      await page.waitForTimeout(80);
      await page.screenshot({
        path: `${outDir}/03-message-enter-animating.png`,
        fullPage: false,
      });
      await page.waitForTimeout(1200);
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `${outDir}/04-message-enter-anchored.png`,
        fullPage: false,
      });
    });
  });
});
