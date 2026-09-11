/**
 * fake quota-tool — 可编程的本地 HTTP 桩（T2 测试基座，SPEC #1 mock 桩前置票）
 *
 * 端点与请求/响应契约逐字段对齐真实多厂家额度查询工具（只读参考
 * D:\Develop\multi-vendor-quota-tool 的 app.mjs，不依赖该仓库）：
 * - POST /api/query，请求 body {provider, credentials}
 *   - 请求体非法 JSON → HTTP 400 {error:'请求体不是合法 JSON'}
 *   - 未注册 provider → HTTP 200 {ok:false, error:'未知厂家: <id>'}
 *   - 脚本错误（含凭证拒绝）→ HTTP 200 {ok:false, error:'<消息>'}（与真实
 *     服务一致：供应商级失败走 HTTP 200 + ok:false，不是 4xx/5xx）
 *   - 脚本成功 → HTTP 200 {ok:true, ...result}；result 含统一契约四件：
 *     updatedAt / summary / windows / details，windows 项固定七字段
 *     label/total/used/remaining/percentage/resetAt/unit（数值字段可为
 *     null——异构供应商只给百分比或只给余额是真实约束）
 * - GET /api/version → {version}
 * - GET /api/providers → [{id, name, fields}]（桩不渲染凭证表单，fields 恒空）
 * - 其余路径 → 404 'Not found'
 *
 * 测试按用例用 setScript / startFakeQuotaTool(scripts) 编排每个 provider
 * 的返回：success / error（凭证拒绝）/ timeout（挂起 delayMs 再回包）。
 * 仅服务测试（tests/ 下，不进生产构建路径）；零新依赖（node:http）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── 统一契约类型（字段语义对齐真实 providers/*.mjs 的 normalize 输出） ───

/** 额度窗口：七字段固定契约；total/used/remaining/percentage 允许 null */
export interface QuotaQueryWindow {
  label: string;
  total: number | null;
  used: number | null;
  remaining: number | null;
  percentage: number | null;
  resetAt: string | null;
  unit: string;
}

/** 汇总条目：真实实现里 value 既有字符串（套餐名）也有数值（余额） */
export interface QuotaQuerySummaryItem {
  label: string;
  value: string | number;
}

/** 明细块：真实实现有两种形态 {title, rows} 与 {title, cols, rows} */
export interface QuotaQueryDetail {
  title: string;
  rows: unknown[][];
  cols?: string[];
}

/** 统一契约成功载荷（ok 由服务端合并，与真实 app.mjs 的 {ok:true, ...result} 一致） */
export interface QuotaQueryResult {
  updatedAt: string;
  summary: QuotaQuerySummaryItem[];
  windows: QuotaQueryWindow[];
  details: QuotaQueryDetail[];
  /** 真实实现允许附带契约外扩展字段（如 DeepSeek 的 extra），原样透传 */
  [extra: string]: unknown;
}

// ─── 用例脚本 ─────────────────────────────────────────────

export type ProviderScript =
  | { kind: 'success'; result: QuotaQueryResult }
  | { kind: 'error'; error: string }
  | { kind: 'timeout'; delayMs: number; error?: string };

/**
 * 凭证拒绝脚本：默认文案为 OpenCode 连接器认证失败原话（逐字取自
 * 真实实现 providers/opencode.mjs 的 cookie 路径），可用 message 覆盖成
 * 其他连接器口径（如 API Key 路径或火山「鉴权失败（HTTP 401）」形态）。
 */
export function credentialRejected(
  message = '认证失败 (HTTP 401)，请检查 auth cookie',
): ProviderScript {
  return { kind: 'error', error: message };
}

// ─── 测试夹具 ─────────────────────────────────────────────

export interface FakeQuotaToolRequest {
  readonly provider: string;
  readonly credentials: unknown;
  readonly at: number;
}

export interface QuotaQueryResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface FakeQuotaTool {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: readonly FakeQuotaToolRequest[];
  /** 重编程某 provider 的脚本；传 null 注销（退回「未知厂家」口径） */
  setScript(provider: string, script: ProviderScript | null): void;
  /** 内置查询客户端：超时经由 AbortSignal，供 timeout 脚本用例断言 */
  query(
    provider: string,
    credentials?: unknown,
    timeoutMs?: number,
  ): Promise<QuotaQueryResponse>;
  /** 幂等停服：清挂起定时器、断开连接、释放端口 */
  stop(): Promise<void>;
}

const FAKE_VERSION = '1.0.0';

export async function startFakeQuotaTool(
  scripts: Record<string, ProviderScript> = {},
): Promise<FakeQuotaTool> {
  const scriptMap = new Map<string, ProviderScript>(Object.entries(scripts));
  const requests: FakeQuotaToolRequest[] = [];
  const pendingTimers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/api/version' && req.method === 'GET') {
      sendJson(res, 200, { version: FAKE_VERSION });
      return;
    }

    if (url.pathname === '/api/providers' && req.method === 'GET') {
      sendJson(
        res,
        200,
        [...scriptMap.keys()].map((id) => ({ id, name: id, fields: [] })),
      );
      return;
    }

    if (url.pathname === '/api/query' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let payload: { provider?: unknown; credentials?: unknown };
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          sendJson(res, 400, { error: '请求体不是合法 JSON' });
          return;
        }
        const provider = String(payload.provider);
        requests.push({
          provider,
          credentials: payload.credentials,
          at: Date.now(),
        });
        const script = scriptMap.get(provider);
        if (!script) {
          sendJson(res, 200, { ok: false, error: `未知厂家: ${provider}` });
          return;
        }
        if (script.kind === 'error') {
          sendJson(res, 200, { ok: false, error: script.error });
          return;
        }
        if (script.kind === 'timeout') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            if (!res.writableEnded && !res.destroyed) {
              sendJson(res, 200, {
                ok: false,
                error: script.error ?? '请求超时',
              });
            }
          }, script.delayMs);
          pendingTimers.add(timer);
          return;
        }
        sendJson(res, 200, { ok: true, ...script.result });
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    // 先断连接再等 close，避免 keep-alive 或挂起请求拖住端口释放
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return {
    baseUrl,
    port,
    requests,
    setScript(provider, script) {
      if (script === null) scriptMap.delete(provider);
      else scriptMap.set(provider, script);
    },
    async query(provider, credentials = {}, timeoutMs) {
      const response = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, credentials }),
        signal:
          timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    stop,
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  obj: unknown,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
