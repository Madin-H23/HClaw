import fs from 'node:fs';
import path from 'node:path';

// Windows 适配（#11/#18）：core.autocrlf=true 检出使工作区文件为 CRLF，而
// 文本断言（跨行 needle / 格式契约）以 LF 为基准。读取后统一归一为 LF；
// POSIX 检出无 \r，替换为 no-op，断言内容一字不变。
// 此为各测试分散定义的 readLf/readSourceLf/source/read 的单点收敛（#18）：
// 路径相对仓库根（vitest cwd）解析，绝对路径原样透传，取各处实现的并集。
export const readLf = (file: string): string =>
  fs
    .readFileSync(path.resolve(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n');
