import { findLastTriggerSignalOutsideThink } from './prompt-strategy.js';
import { getConfig } from '../services/config-store.js';

export function isFcErrorRetryEnabled() {
  return getConfig().runtime.enableFcErrorRetry;
}

export function getFcErrorRetryMaxAttempts() {
  return getConfig().runtime.fcErrorRetryMaxAttempts;
}

export function classifyToolFailure(content, triggerSignal, parseResult = null) {
  if (parseResult?.failureType) return parseResult.failureType;
  if (findLastTriggerSignalOutsideThink(content, triggerSignal) === -1) return 'no_fc';
  const afterTrigger = content.slice(findLastTriggerSignalOutsideThink(content, triggerSignal) + triggerSignal.length);
  if (/<function_calls\b/i.test(afterTrigger) && !/<\/function_calls\s*>/i.test(afterTrigger)) return 'truncated';
  return 'syntax_error';
}

export function diagnoseToolParseError(content, triggerSignal, parseResult = null) {
  if (parseResult?.errorDetails) return parseResult.errorDetails;
  if (!content || findLastTriggerSignalOutsideThink(content, triggerSignal) === -1) {
    return `Trigger signal '${triggerSignal}' not found outside <think> blocks`;
  }
  const cleaned = content.slice(findLastTriggerSignalOutsideThink(content, triggerSignal));
  const errors = [];
  if (!/<function_calls\b/i.test(cleaned)) errors.push('Missing <function_calls> tag after trigger signal');
  if (!/<\/function_calls\s*>/i.test(cleaned)) errors.push('Missing closing </function_calls> tag');
  if (!/<function_call\b/i.test(cleaned)) errors.push('No <function_call> blocks found inside <function_calls>');
  if (!/<tool\b/i.test(cleaned)) errors.push('Missing <tool> tag inside function_call');
  if (!/<args_json\b/i.test(cleaned)) errors.push('Missing <args_json> tag inside function_call');
  return errors.join('; ') || 'XML structure appears malformed or arguments failed validation';
}

export function getToolErrorRetryPrompt(originalResponse, errorDetails, triggerSignal, tools = []) {
  const toolListText = tools.length
    ? `\n可用工具列表：\n${tools.map(t => `- ${t.function?.name || t.name}`).join('\n')}`
    : '';

  return `你上一次尝试调用工具，但格式无效无法解析。

你的原始输出：
\`\`\`
${originalResponse}
\`\`\`

错误详情：
${errorDetails}${toolListText}

请重试，严格按以下 XML 格式输出工具调用：
1. 触发信号独占一行，精确为：${triggerSignal}
2. 紧跟 <function_calls> XML 块
3. <args_json> 内必须是合法的 JSON 对象
4. 参数必须与上方工具列表中声明的 schema 匹配
5. </function_calls> 之后不得有任何文字

现在请输出修正后的工具调用，不要输出任何其他内容。`;
}

export function getToolContinuationPrompt(truncatedContent, errorDetails) {
  const tail = String(truncatedContent || '').slice(-1500);
  return `你上一次的输出在工具调用 XML 完成前被截断了。

被截断的输出：
\`\`\`
${tail}
\`\`\`

发生了什么：
${errorDetails}

你有两种选择：

选项 A（推荐 — 续写）：
仅输出从截断点开始的精确续写内容。规则：
- 从截断点的下一个字符精确开始——不要重复任何已输出的文字。
- 如果截断发生在词中间，从该词的下一个字符开始。
- 不要再次输出触发信号或任何已经存在的开标签。
- 以正确的闭合标签（</function_call>、</function_calls>）结束。
- 不要添加任何前后解释文字。

选项 B（仅当你认为之前的输出有错误时）：
从头开始，输出完整的函数调用。先输出触发信号独占一行，然后完整输出 function_calls 块。

请选择选项 A，除非你确信之前的输出包含需要纠正的错误。`;
}

export function isContinuationResponse(retryContent, triggerSignal) {
  const cleaned = String(retryContent || '').trimStart();
  if (!cleaned) return true;
  if (triggerSignal && cleaned.includes(triggerSignal)) return false;
  if (cleaned.startsWith('<function_calls')) return false;
  return true;
}

export function mergeTruncatedAndContinuation(truncated, continuation) {
  return String(truncated || '') + String(continuation || '');
}

export async function attemptToolParseWithRetry({
  content,
  messages = [],
  promptPlan,
  retryToolRequest,
  signal,
  retryEnabled = isFcErrorRetryEnabled(),
  maxAttempts = getFcErrorRetryMaxAttempts(),
} = {}) {
  if (!promptPlan?.toolCallingEnabled || promptPlan.promptInjectionDisabled) {
    return { toolCalls: null, content: null, failureType: 'disabled', attempts: 1, originalContent: content };
  }

  const safeMaxAttempts = Math.min(10, Math.max(1, Number.parseInt(maxAttempts, 10) || 1));
  let currentContent = String(content || '');
  let lastResult = null;

  for (let attempt = 0; attempt < safeMaxAttempts; attempt++) {
    lastResult = promptPlan.parseToolCallsDetailed
      ? promptPlan.parseToolCallsDetailed(currentContent)
      : (promptPlan.parseToolCalls(currentContent) || { toolCalls: null });

    if (lastResult?.toolCalls?.length) {
      return { ...lastResult, attempts: attempt + 1, originalContent: content, finalContent: currentContent };
    }

    const failureType = classifyToolFailure(currentContent, promptPlan.triggerSignal, lastResult);
    if (failureType === 'no_fc') {
      return { toolCalls: null, content: lastResult?.content ?? (currentContent || null), failureType, attempts: attempt + 1, originalContent: content, finalContent: currentContent };
    }

    if (!retryEnabled || !retryToolRequest || attempt >= safeMaxAttempts - 1) {
      return {
        toolCalls: null,
        content: lastResult?.content ?? null,
        failureType,
        errorDetails: diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult),
        attempts: attempt + 1,
        originalContent: content,
        finalContent: currentContent,
      };
    }

    const errorDetails = diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult);
    const retryPrompt = failureType === 'truncated'
      ? getToolContinuationPrompt(currentContent, errorDetails)
      : getToolErrorRetryPrompt(currentContent, errorDetails, promptPlan.triggerSignal, promptPlan.tools);

    const retryContent = await retryToolRequest({
      retryPrompt,
      currentContent,
      messages,
      signal,
      failureType,
      errorDetails,
      attempt: attempt + 1,
    });

    if (failureType === 'truncated' && isContinuationResponse(retryContent, promptPlan.triggerSignal)) {
      currentContent = mergeTruncatedAndContinuation(currentContent, retryContent);
    } else {
      currentContent = String(retryContent || '');
    }
  }

  return {
    toolCalls: null,
    content: lastResult?.content ?? null,
    failureType: lastResult?.failureType || 'syntax_error',
    errorDetails: diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult),
    attempts: safeMaxAttempts,
    originalContent: content,
    finalContent: currentContent,
  };
}
