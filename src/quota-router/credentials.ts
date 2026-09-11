/**
 * quota-tool 查询凭证自持加密存储（HClaw 原创模块，SPEC #1「quota-tool 凭证自持」）
 *
 * admin 登记的各供应商 quota-tool 查询凭证（火山 AK/SK、OpenCode cookie、
 * DeepSeek API Key 等）按上游加密落盘模式自存：AES-256-GCM 加密后写
 * data/config/quota-router-credentials.json，密钥复用上游会话级密钥文件
 * （data/config/claude-provider.key，各渠道 secret 同源），明文不落盘。
 *
 * 落盘与加密工具函数原样复用上游 runtime-config（T3 仅放开可见性，函数体
 * 零改动）：writeSecretFile 的 0o600 + tmp+rename 原子写、encryptChannelSecret
 * 的 AES-256-GCM 三件套（iv/tag/data）。存储位置与格式：
 * { version, entries: { <供应商 profileId>: {iv,tag,data} } }，每条独立加密
 * （上游 V4「每个供应商的 secrets 独立加密」同款），单条损坏不殃及整库。
 */
import fs from 'fs';
import path from 'path';

import {
  decryptChannelSecret,
  encryptChannelSecret,
  writeSecretFile,
} from '../runtime-config.js';
import { logger } from '../logger.js';

/** 加密信封：与上游 EncryptedSecrets 同构（AES-256-GCM 三件套，base64） */
interface EncryptedEnvelope {
  iv: string;
  tag: string;
  data: string;
}

/** 磁盘格式：每供应商凭证独立加密 */
interface CredentialStoreFile {
  version: 1;
  entries: Record<string, EncryptedEnvelope>;
}

const CURRENT_VERSION = 1;

/** 凭证载荷：quota-tool 侧厂家 id + 该厂家的凭证字段（任意 JSON 形态） */
export interface QuotaCredentialRecord {
  readonly quotaToolProvider: string;
  /** 凭证字段原样透传给 quota-tool /api/query（本侧永不解构、永不落明文） */
  readonly credentials: unknown;
}

/**
 * 凭证存取。filePath 指向 data/config/ 体系内的 JSON 文件（生产默认
 * data/config/quota-router-credentials.json，由装配侧传入）。
 * 文件缺失/损坏按空库处理（fail-open，ADR-0004）——单条解密失败跳过该条。
 */
export class QuotaCredentialStore {
  private readonly filePath: string;
  private cache: CredentialStoreFile | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 保存（覆盖式）一个供应商的凭证，立即原子落盘 */
  save(providerId: string, record: QuotaCredentialRecord): void {
    const store = this.load();
    store.entries[providerId] =
      encryptChannelSecret<QuotaCredentialRecord>(record);
    this.flush(store);
  }

  /** 读取一个供应商的凭证；未登记/单条损坏返回 null（调用侧按 missing 走） */
  get(providerId: string): QuotaCredentialRecord | null {
    const envelope = this.load().entries[providerId];
    if (!envelope) return null;
    try {
      return decryptChannelSecret<QuotaCredentialRecord>(envelope);
    } catch (err) {
      logger.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'quota-router credential decrypt failed; treating as unconfigured',
      );
      return null;
    }
  }

  /** 已登记的供应商 profileId 列表（不触碰凭证内容） */
  list(): string[] {
    return Object.keys(this.load().entries);
  }

  /** 删除一个供应商的凭证，立即落盘；不存在则无操作 */
  delete(providerId: string): void {
    const store = this.load();
    if (!(providerId in store.entries)) return;
    delete store.entries[providerId];
    this.flush(store);
  }

  // ─── 内部 ─────────────────────────────────────────────────

  private load(): CredentialStoreFile {
    if (this.cache) return this.cache;
    let store: CredentialStoreFile = { version: CURRENT_VERSION, entries: {} };
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(this.filePath, 'utf-8'),
        ) as Partial<CredentialStoreFile> | null;
        if (
          raw &&
          typeof raw === 'object' &&
          raw.entries &&
          typeof raw.entries === 'object'
        ) {
          store = {
            version: CURRENT_VERSION,
            entries: raw.entries as Record<string, EncryptedEnvelope>,
          };
        }
      } catch (err) {
        logger.warn(
          {
            file: path.basename(this.filePath),
            err: err instanceof Error ? err.message : String(err),
          },
          'quota-router credential file unreadable; starting from empty store',
        );
      }
    }
    this.cache = store;
    return store;
  }

  private flush(store: CredentialStoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeSecretFile(this.filePath, JSON.stringify(store, null, 2));
    this.cache = store;
  }
}
