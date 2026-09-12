import { describe, expect, test } from 'vitest';

import {
  RATE_WINDOW_MS,
  decideDelivery,
  type DeliveryDecisionInput,
  type QuietWindow,
  type RateControlState,
} from '../src/proactive-message/delivery-decision.js';

// 投递决策纯函数（票 #22，SPEC #20「投递决策纯函数」缝）行为级测试：
// 只断言可观察行为（送达/持有/丢弃 + 一行中文理由），时钟与状态全部注入，
// 无任何真实时间依赖。fail-open 方向在本文件钉死：状态不可用 = 放行送达
// （宁多勿丢，ADR-0008）——与额度路由 ADR-0004「故障不放行」方向相反。

const NOW_MS = Date.parse('2026-09-11T12:00:00Z'); // 周五；UTC+8 = 20:00

const EMPTY_STATE: RateControlState = {
  recentSendTimesMs: [],
  recentSendsOfKey: [],
};

function baseInput(
  overrides?: Partial<DeliveryDecisionInput>,
): DeliveryDecisionInput {
  return {
    channelId: 'feishu',
    target: 'ou_admin',
    messageKey: 'morning-check',
    contentDigest: 'digest-v1',
    channelLimitPerMinute: 10,
    quietWindows: [],
    cooldownMs: 0,
    state: EMPTY_STATE,
    nowMs: NOW_MS,
    ...overrides,
  };
}

/** 窗口便捷构造：HH:mm + 固定 UTC 偏移 → 分钟形态（与配置装载产物同构） */
function window(
  start: string,
  end: string,
  options?: { days?: readonly number[]; offsetMinutes?: number },
): QuietWindow {
  const toMinute = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return {
    startMinuteOfDay: toMinute(start),
    endMinuteOfDay: toMinute(end),
    days: options?.days ?? [],
    timeZoneOffsetMinutes: options?.offsetMinutes ?? 480,
  };
}

// ─── 三层各自独立生效 ────────────────────────────────────────

describe('第一层：渠道全局限速（滑动窗口）', () => {
  test('窗口内发送数未达上限 → 送达', () => {
    const decision = decideDelivery(
      baseInput({
        channelLimitPerMinute: 3,
        state: {
          recentSendTimesMs: [NOW_MS - 50_000, NOW_MS - 10_000],
          recentSendsOfKey: [],
        },
      }),
    );
    expect(decision.kind).toBe('deliver');
    expect(decision.failOpen).toBe(false);
  });

  test('恰好达限（达到即持有，不等超出）→ 持有，理由含渠道与上限', () => {
    const decision = decideDelivery(
      baseInput({
        channelId: 'dingtalk',
        channelLimitPerMinute: 3,
        state: {
          recentSendTimesMs: [NOW_MS - 59_000, NOW_MS - 30_000, NOW_MS - 1_000],
          recentSendsOfKey: [],
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'rate-limit' });
    expect(decision.reason).toContain('dingtalk');
    expect(decision.reason).toContain('每分钟上限 3 条');
  });

  test('恰好整窗老的发送已过期不计（边界：t = now - 60s 不计入）', () => {
    const decision = decideDelivery(
      baseInput({
        channelLimitPerMinute: 2,
        state: {
          recentSendTimesMs: [
            NOW_MS - RATE_WINDOW_MS,
            NOW_MS - RATE_WINDOW_MS + 1,
          ],
          recentSendsOfKey: [],
        },
      }),
    );
    expect(decision.kind).toBe('deliver');
  });

  test('未来时间戳计入滑窗（时钟回拨保守处理：宁可多算不多发）', () => {
    // sentAtMs > nowMs 的记录（时钟回拨产物）按注释承诺计入滑窗——
    // 只设下界 sentAtMs > now - 60s，无上界
    const decision = decideDelivery(
      baseInput({
        channelLimitPerMinute: 1,
        state: {
          recentSendTimesMs: [NOW_MS + 5_000],
          recentSendsOfKey: [],
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'rate-limit' });
  });

  test('限速不看目标：同渠道不同目标的发送合并计数（渠道全局语义）', () => {
    const decision = decideDelivery(
      baseInput({
        channelLimitPerMinute: 1,
        state: { recentSendTimesMs: [NOW_MS - 1_000], recentSendsOfKey: [] },
      }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'rate-limit' });
  });

  test('限速为 0 → 不启用（防御口径：<=0 视为不限速）', () => {
    const decision = decideDelivery(baseInput({ channelLimitPerMinute: 0 }));
    expect(decision.kind).toBe('deliver');
  });
});

describe('第二层：任务级静默窗口', () => {
  test('当前时刻在窗口内 → 持有，理由含窗口时段与补发语义', () => {
    // 12:00Z = UTC+8 20:00，落在 19:00–21:00 内
    const decision = decideDelivery(
      baseInput({ quietWindows: [window('19:00', '21:00')] }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'quiet-window' });
    expect(decision.reason).toContain('静默窗口');
    expect(decision.reason).toContain('19:00');
    expect(decision.reason).toContain('补发');
  });

  test('起点含（恰在 start 分钟 → 窗口内）、终点不含（恰在 end 分钟 → 窗口外）', () => {
    const windows = [window('19:00', '21:00')];
    expect(
      decideDelivery(
        baseInput({
          quietWindows: windows,
          nowMs: Date.parse('2026-09-11T11:00:00Z'),
        }),
      ).kind,
    ).toBe('hold'); // UTC+8 19:00 整 = 起点，含
    expect(
      decideDelivery(
        baseInput({
          quietWindows: windows,
          nowMs: Date.parse('2026-09-11T13:00:00Z'),
        }),
      ).kind,
    ).toBe('deliver'); // UTC+8 21:00 整 = 终点，不含
  });

  test('跨零点窗口（23:00–07:00）：凌晨段落在窗口内', () => {
    // 2026-09-11T16:00:00Z = UTC+8 周六 00:00
    const decision = decideDelivery(
      baseInput({
        quietWindows: [window('23:00', '07:00')],
        nowMs: Date.parse('2026-09-11T16:00:00Z'),
      }),
    );
    expect(decision.kind).toBe('hold');
  });

  test('星期过滤锚定窗口起点所在日：跨零点凌晨段按「昨天」的星期判定', () => {
    const fridayWindow = window('23:00', '07:00', { days: [5] }); // 周五起锚
    // 周五 23:00（起点）→ 持有
    expect(
      decideDelivery(
        baseInput({
          quietWindows: [fridayWindow],
          nowMs: Date.parse('2026-09-11T15:00:00Z'),
        }),
      ).kind,
    ).toBe('hold');
    // 周六凌晨 00:30（窗口起于周五）→ 仍按周五判定 → 持有
    expect(
      decideDelivery(
        baseInput({
          quietWindows: [fridayWindow],
          nowMs: Date.parse('2026-09-11T16:30:00Z'),
        }),
      ).kind,
    ).toBe('hold');
    // 周六 23:30（窗口起于周六，days 只含周五）→ 不命中 → 送达
    expect(
      decideDelivery(
        baseInput({
          quietWindows: [fridayWindow],
          nowMs: Date.parse('2026-09-12T15:30:00Z'),
        }),
      ).kind,
    ).toBe('deliver');
  });

  test('时区偏移生效：offset=0 的 10:00–11:00 窗口在 10:30Z 命中（同一时刻 offset=480 视角在窗外）', () => {
    const nowMs = Date.parse('2026-09-11T10:30:00Z');
    expect(
      decideDelivery(
        baseInput({
          quietWindows: [window('10:00', '11:00', { offsetMinutes: 0 })],
          nowMs,
        }),
      ).kind,
    ).toBe('hold');
    // 同一时刻按 UTC+8 解释（默认偏移）已在 18:30，不落 10:00–11:00 → 送达
    expect(
      decideDelivery(
        baseInput({ quietWindows: [window('10:00', '11:00')], nowMs }),
      ).kind,
    ).toBe('deliver');
  });

  test('start === end 视为全天静默', () => {
    const decision = decideDelivery(
      baseInput({ quietWindows: [window('12:00', '12:00')] }),
    );
    expect(decision.kind).toBe('hold');
  });

  test('days 声明不含当天 → 不命中', () => {
    // 周五（dow=5），窗口只声明周六
    const decision = decideDelivery(
      baseInput({ quietWindows: [window('19:00', '21:00', { days: [6] })] }),
    );
    expect(decision.kind).toBe('deliver');
  });
});

describe('第三层：冷却去重', () => {
  test('冷却窗内已发过同内容 → 丢弃，理由含冷却语义', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 300_000, contentDigest: 'digest-v1' },
          ],
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'discard' });
    expect(decision.reason).toContain('冷却');
    expect(decision.reason).toContain('相同内容');
  });

  test('同类型不同内容（摘要不同）→ 不算重复，照常送达', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 1_000, contentDigest: 'digest-v2' },
          ],
        },
      }),
    );
    expect(decision.kind).toBe('deliver');
  });

  test('A-B-A 交替内容：窗内任一同摘要记录都构成重复（不只因最近一条）', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 500_000, contentDigest: 'digest-v1' },
            { sentAtMs: NOW_MS - 100_000, contentDigest: 'digest-v2' },
          ],
        },
      }),
    );
    expect(decision.kind).toBe('discard');
  });

  test('冷却窗恰好过期（now - sentAt = cooldownMs）→ 放行送达（边界）', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 600_000, contentDigest: 'digest-v1' },
          ],
        },
      }),
    );
    expect(decision.kind).toBe('deliver');
  });

  test('冷却窗内最后 1ms 仍判重复（边界：now - sentAt = cooldownMs - 1）', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 599_999, contentDigest: 'digest-v1' },
          ],
        },
      }),
    );
    expect(decision.kind).toBe('discard');
  });

  test('cooldownMs = 0 → 去重关闭（缺省方向：配置缺失不造成少发）', () => {
    const decision = decideDelivery(
      baseInput({
        cooldownMs: 0,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [{ sentAtMs: NOW_MS, contentDigest: 'digest-v1' }],
        },
      }),
    );
    expect(decision.kind).toBe('deliver');
  });
});

// ─── 叠加组合（评估顺序：冷却 → 静默 → 限速 → 送达） ─────────

describe('三层叠加组合', () => {
  const fullLayers = {
    channelLimitPerMinute: 1,
    quietWindows: [window('19:00', '21:00')],
    cooldownMs: 600_000,
    state: {
      recentSendTimesMs: [NOW_MS - 1_000],
      recentSendsOfKey: [
        { sentAtMs: NOW_MS - 1_000, contentDigest: 'digest-v1' },
      ],
    },
  };

  test('三层全命中 → 冷却丢弃优先（重复消息不当场保留重试预算）', () => {
    const decision = decideDelivery(baseInput(fullLayers));
    expect(decision.kind).toBe('discard');
  });

  test('静默 + 限速命中（非重复）→ 静默持有优先（窗口决定最早可走时刻）', () => {
    const decision = decideDelivery(
      baseInput({
        ...fullLayers,
        state: {
          recentSendTimesMs: fullLayers.state.recentSendTimesMs,
          recentSendsOfKey: [],
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'quiet-window' });
  });

  test('冷却 + 限速命中（无静默）→ 冷却丢弃优先', () => {
    const decision = decideDelivery(
      baseInput({ ...fullLayers, quietWindows: [] }),
    );
    expect(decision.kind).toBe('discard');
  });
});

// ─── fail-open（方向钉死：状态不可用 = 放行，宁多勿丢） ───────

describe('fail-open：频控状态不可用 → 送达（宁多勿丢，ADR-0008）', () => {
  test('state = null → 送达且 failOpen = true，理由明示放行与方向', () => {
    const decision = decideDelivery(baseInput({ state: null }));
    expect(decision).toMatchObject({ kind: 'deliver', failOpen: true });
    expect(decision.reason).toContain('fail-open');
    expect(decision.reason).toContain('宁多勿丢');
  });

  test('状态缺失时冷却去重同样放行（宁多勿丢没有「该去重时去重」的例外）', () => {
    // 即便配置了冷却窗，状态不可用也直发——存储故障不许吞通知
    const decision = decideDelivery(
      baseInput({ state: null, cooldownMs: 600_000 }),
    );
    expect(decision).toMatchObject({ kind: 'deliver', failOpen: true });
  });

  test('fail-open 最激进后果：state=null + 静默窗口已声明 → 仍绕过静默直发', () => {
    // 20:00（UTC+8）在 19:00–21:00 窗口内：状态可用时必持有；状态不可用时
    // fail-open 连最重的静默层也一并绕过——这是「宁多勿丢」方向的最激进落点
    const decision = decideDelivery(
      baseInput({ state: null, quietWindows: [window('19:00', '21:00')] }),
    );
    expect(decision).toMatchObject({ kind: 'deliver', failOpen: true });
    // 对照钉死：同一输入只把状态接上 → 立刻被静默层持有
    const withState = decideDelivery(
      baseInput({ quietWindows: [window('19:00', '21:00')] }),
    );
    expect(withState).toMatchObject({ kind: 'hold', holdKind: 'quiet-window' });
  });

  test('方向辨析对照：这不是额度路由的 fail-open——额度路由故障不放行（ADR-0004），频控故障必放行（ADR-0008）', () => {
    // 同一函数：状态可用但空（正常无历史）与状态不可用（null）都送达，
    // 但 failOpen 标记不同——正常放行 false，故障放行 true，方向钉在标记上
    const normal = decideDelivery(baseInput());
    const broken = decideDelivery(baseInput({ state: null }));
    expect(normal).toMatchObject({ kind: 'deliver', failOpen: false });
    expect(broken).toMatchObject({ kind: 'deliver', failOpen: true });
  });
});

// ─── 静默补发语义 ────────────────────────────────────────────

describe('静默补发语义（持有 → 窗口结束首次触发 → 送达）', () => {
  test('窗口内持有；同一输入只推进时钟到窗口终点外 → 送达', () => {
    const windows = [window('19:00', '21:00')];
    const inside = decideDelivery(
      baseInput({
        quietWindows: windows,
        nowMs: Date.parse('2026-09-11T11:59:00Z'),
      }),
    );
    expect(inside).toMatchObject({ kind: 'hold', holdKind: 'quiet-window' });
    // 补发 = 调用方下次触发时重新决策（无独立定时器）：nowMs 推进到 21:00 整
    const afterWindow = decideDelivery(
      baseInput({
        quietWindows: windows,
        nowMs: Date.parse('2026-09-11T13:00:00Z'),
      }),
    );
    expect(afterWindow).toMatchObject({ kind: 'deliver', failOpen: false });
  });

  test('补发时若限速已满 → 再次持有（补发不是豁免，仍受其余两层节制）', () => {
    const windows = [window('19:00', '21:00')];
    const state: RateControlState = {
      recentSendTimesMs: [Date.parse('2026-09-11T13:00:00Z') - 1_000],
      recentSendsOfKey: [],
    };
    const decision = decideDelivery(
      baseInput({
        quietWindows: windows,
        channelLimitPerMinute: 1,
        state,
        nowMs: Date.parse('2026-09-11T13:00:00Z'),
      }),
    );
    expect(decision).toMatchObject({ kind: 'hold', holdKind: 'rate-limit' });
  });
});

// ─── 纯函数纪律：幂等 / 零时钟依赖 / reason 质量 ─────────────

describe('纯函数纪律', () => {
  test('幂等：同输入重复决策结果深相等（含 reason）', () => {
    const input = baseInput({
      channelLimitPerMinute: 2,
      quietWindows: [window('19:00', '21:00')],
      cooldownMs: 600_000,
      state: {
        recentSendTimesMs: [NOW_MS - 1_000],
        recentSendsOfKey: [
          { sentAtMs: NOW_MS - 1_000, contentDigest: 'digest-v1' },
        ],
      },
    });
    const first = decideDelivery(input);
    const second = decideDelivery(input);
    expect(second).toEqual(first);
    // 时钟推进改变结果只经由 nowMs 参数——无隐藏时钟：推进到静默窗口终点
    // （UTC+8 21:00 整，终点不含→窗外）且早已过冷却窗 → 丢弃翻转为送达
    const advanced = decideDelivery({
      ...input,
      nowMs: input.nowMs + 3_600_000,
    });
    expect(first.kind).toBe('discard');
    expect(advanced.kind).toBe('deliver');
  });

  test('每个决策的 reason 非空、无 undefined/null 泄漏', () => {
    const inputs: DeliveryDecisionInput[] = [
      baseInput(),
      baseInput({ state: null }),
      baseInput({
        channelLimitPerMinute: 1,
        state: { recentSendTimesMs: [NOW_MS], recentSendsOfKey: [] },
      }),
      baseInput({ quietWindows: [window('19:00', '21:00')] }),
      baseInput({
        cooldownMs: 600_000,
        state: {
          recentSendTimesMs: [],
          recentSendsOfKey: [
            { sentAtMs: NOW_MS - 1_000, contentDigest: 'digest-v1' },
          ],
        },
      }),
    ];
    for (const input of inputs) {
      const decision = decideDelivery(input);
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason).not.toMatch(/undefined|NaN/);
    }
  });
});
