import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

// Windows 适配（#11）：core.autocrlf=true 检出使工作区源码为 CRLF，而本测试
// 的文本断言（跨行 needle / 格式契约）以 LF 为基准。读取源码后统一归一为
// LF；POSIX 检出无 \r，替换为 no-op，断言内容一字不变。
const readLf = (file: string): string =>
  fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('dynamic Workflow product contract', () => {
  test('uses official SDK task metadata and output files', () => {
    const processor = readLf('container/agent-runner/src/stream-processor.ts');
    const projection = readLf('container/agent-runner/src/workflow-run.ts');

    expect(processor).toContain('task_started');
    expect(processor).toContain('task_type');
    expect(processor).toContain('workflow_name');
    expect(processor).toContain('workflowRunFromOutputFile');
    expect(projection).toContain('raw.workflowProgress');
    expect(projection).toContain('input.usage?.total_tokens');
  });

  test('renders workflow and normal answer as separate presentation regions', () => {
    const bubble = readLf('web/src/components/chat/MessageBubble.tsx');
    const card = readLf('web/src/components/chat/WorkflowRunCard.tsx');

    expect(bubble).toContain('<WorkflowRunCard');
    expect(bubble).toContain('<MarkdownRenderer');
    expect(card).toContain('动态工作流');
    expect(card).toContain('工具调用');
    expect(card).toContain('任务摘要');
    expect(card).toContain('结果摘要');
    expect(card).toContain('role="progressbar"');
    expect(card).toContain('执行信息');
    expect(card).toContain('value <= 0');
    expect(card).toContain('run.totalToolCalls > 0');
  });

  test('makes the Workflow card the only running progress surface', () => {
    const list = readLf('web/src/components/chat/MessageList.tsx');
    const streaming = readLf('web/src/components/chat/StreamingDisplay.tsx');
    const projection = readLf('container/agent-runner/src/workflow-run.ts');

    expect(list).toContain('isHeldBackgroundAcknowledgement');
    expect(streaming).toContain('hasWorkflowCards');
    expect(streaming).not.toContain('调用轨迹');
    expect(projection).toContain("label.includes('${')");
    expect(projection).toContain('workflowRunFromTaskProgress');
  });

  test('uses the same final-only presentation in conversation previews', () => {
    const sidebar = readLf('web/src/components/chat/SessionSidebar.tsx');

    expect(sidebar).toContain('getPresentedMessageContent');
  });

  test('keeps running Workflow state across a held background acknowledgement', () => {
    const backend = readLf('src/index.ts');
    const store = readLf('web/src/stores/chat.ts');

    expect(backend).toContain('activeWorkflowRuns');
    expect(backend).toContain('activeAgentWorkflowRuns');
    expect(backend).toContain('workflowRuns: holdReason');
    expect(backend).toContain('workflow_runs: holdReason');
    expect(backend).toContain(
      'if (!holdReason) {\n                clearStreamingSnapshot(chatJid)',
    );
    expect(store).toContain('streamingStateFromWorkflowRuns');
    expect(store).toContain('holdsRunningWorkflow');
  });
});
