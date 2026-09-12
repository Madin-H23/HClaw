/**
 * 内嵌 server 引导（T8，ADR-0007）——electron main 进程内启动完整 HClaw server。
 *
 * 技术路径（ADR-0007 三选一取最小可靠者）：main 进程动态 import 后端 tsc 编译
 * 产物 dist/index.js——与 `npm start` 完全同一份运行时形态，不做 esbuild 二次
 * 打包（787KB 巨石 + IM SDK 群的 bundle 转换风险高），不 spawn 子进程（免随包
 * 带 Node 运行时）。上游 main() 在模块尾部自启（initDatabase→startWebServer→
 * scheduler→IM），import 即完成装配——src/ 零 diff。
 *
 * cwd 杠杆：上游 config.ts 以 process.cwd() 锚定 DATA_DIR（data/），web.ts 以
 * './web/dist' 相对 cwd 服务静态前端。内嵌启动先 chdir 到可写 server 根目录
 * （userData/server），再把随包 web 前端产物物化到该目录 web/dist——数据面与
 * 静态面同锚。端口经上游既有 WEB_PORT env 注入（config.ts 口径），src/ 零改动。
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';

/** 上游 web.ts 静态根 './web/dist' 相对 cwd 解析——物化目录名必须保持 web/dist */
const WEB_DIST_DEST = path.join('web', 'dist');
/** 物化版本戳：包版本变化（升级安装）时重物化前端产物 */
const WEB_STAMP_FILE = '.web-dist-version';
const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_READY_POLL_MS = 250;
const LOG_MAX_BYTES = 1024 * 1024;

export type EmbedLogger = (message: string) => void;

/** server 根目录（可写）：userData/server——chdir 锚定后 DATA_DIR=server/data */
function getServerRoot(): string {
  return path.join(app.getPath('userData'), 'server');
}

/** web 前端产物来源：打包=resources/web-dist（extraResources）；开发=仓库 web/dist */
function resolveWebDistSource(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web-dist');
  // 开发态 app.getAppPath()=electron/，仓库根为其上一级
  return path.join(app.getAppPath(), '..', 'web', 'dist');
}

/**
 * 宿主机 agent 执行轮依赖来源：打包=resources/container/agent-runner；
 * 开发=仓库 container/agent-runner（container-runner preflight 按 cwd 相对
 * 检查 node_modules/dist，junction 物化后透传解析）。
 */
function resolveAgentRunnerSource(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'container', 'agent-runner');
  }
  return path.join(app.getAppPath(), '..', 'container', 'agent-runner');
}

/**
 * 把宿主机 agent 执行轮依赖物化到 serverRoot/container/agent-runner。
 * Windows 目录 junction：零拷贝、免管理员；已物化且可达则跳过。junction 建
 * 不出来（杀软/策略）时退回递归拷贝（慢但可用），再失败则放行——preflight
 * 会给出结构化 setup 错误（不阻塞数据面/面板）。
 */
function materializeAgentRunner(serverRoot: string, log: EmbedLogger): void {
  const source = resolveAgentRunnerSource();
  if (!fs.existsSync(path.join(source, 'dist', 'pi-index.js'))) {
    log(`agent-runner 产物不存在，跳过物化：${source}`);
    return;
  }
  const containerDir = path.join(serverRoot, 'container');
  const linkPath = path.join(containerDir, 'agent-runner');
  if (fs.existsSync(path.join(linkPath, 'dist', 'pi-index.js'))) return;

  fs.mkdirSync(containerDir, { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  try {
    fs.symlinkSync(source, linkPath, 'junction');
    log(`agent-runner 已 junction：${linkPath} → ${source}`);
    return;
  } catch (err) {
    log(
      `junction 创建失败，退回拷贝：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    fs.cpSync(source, linkPath, { recursive: true });
    log(`agent-runner 已拷贝物化：${linkPath}`);
  } catch (err) {
    log(
      `agent-runner 物化失败（preflight 将报 setup 错误，不阻塞其他面）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 内嵌 server 入口：打包=app.asar.unpacked/dist/index.js（dist 整体 asarUnpack，
 * ESM import 与原生模块 require 全部落在真实文件系统）；开发=仓库 dist/index.js。
 */
function resolveServerEntry(): string {
  const appPath = app.getAppPath();
  const root = app.isPackaged
    ? appPath.replace(/app\.asar$/, 'app.asar.unpacked')
    : path.join(appPath, '..');
  return path.join(root, 'dist', 'index.js');
}

function appendLog(logPath: string, message: string): void {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
      fs.truncateSync(logPath, 0);
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

/**
 * 把随包 web 前端产物物化到 serverRoot/web/dist（serveStatic 相对 cwd 的锚点）。
 * 打包态按版本戳幂等（升级重物化）；开发态每次重拷（web 构建随开发变动）。
 */
function materializeWebDist(serverRoot: string, log: EmbedLogger): void {
  const source = resolveWebDistSource();
  const dest = path.join(serverRoot, WEB_DIST_DEST);
  if (!fs.existsSync(source)) {
    // 打包态必有（extraResources 随包）；开发态可能未跑 build:web——放行使
    // 静态 404，由壳的错误页兜底，不阻塞 server 数据面
    log(`web 前端产物不存在，跳过物化：${source}`);
    return;
  }

  const stampPath = path.join(serverRoot, WEB_STAMP_FILE);
  const stamp = app.isPackaged ? app.getVersion() : null;
  if (stamp) {
    try {
      const current = fs.readFileSync(stampPath, 'utf8').trim();
      if (current === stamp && fs.existsSync(path.join(dest, 'index.html'))) {
        log(`web 前端已是当前版本（${stamp}），跳过物化`);
        return;
      }
    } catch {
      // 无戳/读取失败 → 重物化
    }
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true });
  if (stamp) fs.writeFileSync(stampPath, `${stamp}\n`, 'utf8');
  log(`web 前端已物化：${dest}`);
}

/** 取一个空闲 TCP 端口（listen(0) 由内核分配后立刻让出） */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('无法获取空闲端口'));
      });
    });
  });
}

/** 轮询 TCP 连接直到 server 监听就绪（上游 startWebServer 完成装配的信号） */
function waitUntilListening(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(
            new Error(
              `内嵌 server ${timeoutMs}ms 内未进入监听（port=${port}）`,
            ),
          );
          return;
        }
        setTimeout(attempt, SERVER_READY_POLL_MS);
      });
    };
    attempt();
  });
}

/**
 * 启动内嵌 server，返回其 base URL（http://127.0.0.1:<空闲端口>）。
 * 抛错由调用方处理（壳侧弹窗 + 回退缺省地址，ADR-0007 降级形态）。
 */
export async function startEmbeddedServer(log: EmbedLogger): Promise<string> {
  const serverRoot = getServerRoot();
  fs.mkdirSync(serverRoot, { recursive: true });
  const logPath = path.join(serverRoot, 'embedded-server.log');
  const writeLog = (message: string): void => {
    appendLog(logPath, message);
    log(message);
  };

  writeLog(`内嵌 server 根目录：${serverRoot}`);
  // main() 失败路径会 logger.error 后 process.exit(1)——至少把退出码留档
  process.on('exit', (code) => {
    if (code !== 0) appendLog(logPath, `server 进程退出 code=${code}`);
  });

  materializeWebDist(serverRoot, writeLog);
  materializeAgentRunner(serverRoot, writeLog);

  const entry = resolveServerEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`内嵌 server 入口不存在：${entry}`);
  }

  const port = await pickFreePort();
  process.env.WEB_PORT = String(port);
  process.chdir(serverRoot);
  writeLog(`WEB_PORT=${port}，cwd=${process.cwd()}`);

  writeLog(`加载 server 入口：${entry}`);
  // 上游 main() 在模块尾部自启：import 返回即装配已开始（异步推进）
  await import(pathToFileURL(entry).href);
  writeLog('server 入口加载完成，等待监听就绪…');

  await waitUntilListening(port, SERVER_READY_TIMEOUT_MS);
  const baseUrl = `http://127.0.0.1:${port}`;
  writeLog(`内嵌 server 就绪：${baseUrl}`);
  return baseUrl;
}
