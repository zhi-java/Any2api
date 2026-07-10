import { createInternalId } from './internal-request.js';
import { validateParsedTools } from './tool-validation.js';
import {
  getRawJsonPromptForRequest,
  isPromptInjectionDisabledForRequest,
  normalizeTools,
} from '../utils/response-utils.js';

const TRIGGER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateTriggerSignal(length = 4) {
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += TRIGGER_CHARS[Math.floor(Math.random() * TRIGGER_CHARS.length)];
  }
  return `<Function_${suffix}_Start/>`;
}

function forcedToolName(toolChoice) {
  return toolChoice?.function?.name || toolChoice?.name || undefined;
}

function isNoneToolChoice(toolChoice) {
  return toolChoice === 'none' || toolChoice?.type === 'none';
}

function schemaTypeName(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.filter(t => typeof t === 'string').join(' | ') || 'any';
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) return 'object';
  if (schema.items) return 'array';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.allOf)) return 'allOf';
  return 'any';
}

function dumpPromptValue(value) {
  try { return JSON.stringify(value, null, 0); } catch { return String(value); }
}

function appendSchemaSummary(lines, schema, isRequired, indentLevel, depth = 0) {
  const schemaObj = schema && typeof schema === 'object' ? schema : {};
  const indent = '  '.repeat(indentLevel);

  if (depth > 6) {
    lines.push(`${indent}- note: nested schema omitted after depth 6`);
    return;
  }

  lines.push(`${indent}- type: ${schemaTypeName(schemaObj)}`);
  if (isRequired != null) lines.push(`${indent}- required: ${isRequired ? 'Yes' : 'No'}`);
  if (schemaObj.description) lines.push(`${indent}- description: ${schemaObj.description}`);
  if (schemaObj.enum) lines.push(`${indent}- enum: ${dumpPromptValue(schemaObj.enum)}`);
  if (schemaObj.default !== undefined) lines.push(`${indent}- default: ${dumpPromptValue(schemaObj.default)}`);

  const constraints = {};
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']) {
    if (schemaObj[key] !== undefined) constraints[key] = schemaObj[key];
  }
  if (Object.keys(constraints).length) lines.push(`${indent}- constraints: ${dumpPromptValue(constraints)}`);

  const props = schemaObj.properties && typeof schemaObj.properties === 'object' ? schemaObj.properties : null;
  const required = Array.isArray(schemaObj.required) ? schemaObj.required.filter(k => typeof k === 'string') : [];
  if (props && Object.keys(props).length) {
    lines.push(`${indent}- properties:`);
    for (const [name, child] of Object.entries(props)) {
      lines.push(`${'  '.repeat(indentLevel + 1)}- ${name}:`);
      appendSchemaSummary(lines, child, required.includes(name), indentLevel + 2, depth + 1);
    }
  }

  if (schemaObj.items && typeof schemaObj.items === 'object') {
    lines.push(`${indent}- items:`);
    appendSchemaSummary(lines, schemaObj.items, null, indentLevel + 1, depth + 1);
  }
}

function renderToolList(tools) {
  return tools.map((tool, index) => {
    const fn = tool.function || tool;
    const parameters = fn.parameters ?? { type: 'object', properties: {} };
    const props = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
    const required = Array.isArray(parameters.required) ? parameters.required.filter(k => typeof k === 'string') : [];
    const summary = Object.entries(props)
      .map(([name, schema]) => `${name} (${schemaTypeName(schema)})`)
      .join(', ') || 'None';

    const detailLines = [];
    for (const [name, schema] of Object.entries(props)) {
      detailLines.push(`- ${name}:`);
      appendSchemaSummary(detailLines, schema, required.includes(name), 1);
    }

    return `${index + 1}. <tool name="${fn.name}">
   Description:
\`\`\`
${fn.description || ''}
\`\`\`
   Parameters summary: ${summary}
   Required parameters: ${required.length ? required.join(', ') : 'None'}
   Parameter details:
${detailLines.length ? detailLines.join('\n') : '(no parameter details)'}`;
  }).join('\n\n');
}

export function buildXmlToolInstructions({ tools = [], toolChoice = 'auto', triggerSignal } = {}) {
  const normalized = normalizeTools(tools);
  if (!triggerSignal || !normalized.length || isNoneToolChoice(toolChoice)) return '';

  const constraints = [];
  if (toolChoice === 'required') {
    constraints.push('本轮对话中，如果尚未调用任何工具，则必须调用至少一个工具；如果已有工具结果返回，直接基于结果回复即可');
  }
  const forced = forcedToolName(toolChoice);
  if (forced) {
    constraints.push(`只能调用 \`${forced}\` 这一个工具，不得调用其他工具`);
  }

  const firstTool = normalized[0]?.function?.name || 'tool_name';
  const constraintText = constraints.length
    ? `\n\n工具选择约束：\n${constraints.map(line => `- ${line}`).join('\n')}`
    : '';

  // 检测是否为编程类工具集，注入专用规则
  const isCodingToolset = tools.some(tool => {
    const fn = tool.function || tool;
    const props = Object.keys(fn.parameters?.properties || {});
    return props.includes('file_path') || props.includes('command')
      || props.includes('old_string') || props.includes('pattern');
  });

  const codingGuide = isCodingToolset ? `
### 编程场景专用规则

- 先读后改：修改文件前必须 Read 目标文件确认内容，再用 Edit 做精确替换
- Read 大文件时分段读取：先用 limit 控制读取量，继续时用 offset 接续
- 创建新文件用 Write，修改已有文件用 Edit；Notebook 文件用 NotebookEdit
- Edit 的 old_string 必须与文件内容精确匹配，不确定时重新 Read 确认
- 搜索文件名用 Glob，搜索内容用 Grep；不要用 Bash 替代这些专用工具
- Bash 仅用于测试、构建、包管理、git 等需要命令行执行的场景
- Windows 路径使用完整绝对路径和反斜杠` : '';

  return `\n\n## 可用工具

${renderToolList(normalized)}

## 工具调用决策

- 能直接回答的问题，用 Markdown 格式正常回复即可，不要调用工具
- 确实需要工具才能完成的任务，才调用对应工具
- 工具执行结果返回后（以"[系统通知]"开头的消息），直接基于结果回复用户，不要再重复调用相同的工具
- 多个独立的工具调用应在一次响应中同时发出，不要分步串行
- 一次响应中完成所有可预见的工作，避免"调用-等待-再调用"的低效循环
${codingGuide}
## 输出格式

调用工具时严格按以下 XML 格式输出：

${triggerSignal}
<function_calls>
  <function_call>
    <tool>${firstTool}</tool>
    <args_json><![CDATA[{"key":"value"}]]></args_json>
  </function_call>
</function_calls>

注意：<args_json> 内的 JSON 务必用 <![CDATA[...]]> 包裹。参数值可能含引号、反斜杠（如 Windows 路径 C:\\Users\\...）、换行、XML 特殊字符（<、>、&）等，不用 CDATA 会破坏 XML 结构导致解析失败。CDATA 不是可选项，是必须的。

## 必须遵守的规则

- 不需要工具时，直接回复文本，不要输出任何 XML
- 工具执行结果已返回时（"[系统通知]"开头的消息），总结结果直接回复用户，不要重复调用相同的已完成工具
- 触发信号独占一行，与示例完全一致，只出现一次
- 触发信号后紧跟 <function_calls>（中间可有空白）
- 所有调用放在一个 <function_calls> 块内，每个工具一个 <function_call>
- <tool> 的值必须与上方可用工具列表中的名称完全一致
- <args_json> 内是一个 JSON 对象，参数名和类型匹配工具定义
- 参数值中的特殊字符必须用 <![CDATA[...]]> 包裹避免 XML 转义错误
- </function_calls> 之后不得有任何文字${constraintText}`;
}

export function createPromptPlan({ req, tools = [], toolChoice = 'auto' } = {}) {
  const promptInjectionDisabled = isPromptInjectionDisabledForRequest(req);
  if (promptInjectionDisabled) {
    const disabledPrompt = getRawJsonPromptForRequest(req);
    return {
      promptInjectionDisabled: true,
      disabledPrompt,
      tools: [],
      toolChoice: 'none',
      toolCallingEnabled: false,
      triggerSignal: null,
      toolInstructions: '',
      parseToolCalls: () => null,
      parseToolCallsDetailed: () => ({ toolCalls: null, failureType: 'no_fc', errorDetails: 'Prompt injection is disabled' }),
      createStreamDetector: () => null,
    };
  }

  const normalizedTools = normalizeTools(tools);
  const effectiveToolChoice = toolChoice ?? 'auto';
  const toolCallingEnabled = normalizedTools.length > 0 && !isNoneToolChoice(effectiveToolChoice);
  const triggerSignal = toolCallingEnabled ? generateTriggerSignal() : null;
  const toolInstructions = toolCallingEnabled
    ? buildXmlToolInstructions({ tools: normalizedTools, toolChoice: effectiveToolChoice, triggerSignal })
    : '';

  const parseToolCallsDetailed = (text) => parseXmlToolCallsDetailed(text, {
    triggerSignal,
    tools: normalizedTools,
    toolChoice: effectiveToolChoice,
  });
  const parseToolCalls = (text) => {
    const result = parseToolCallsDetailed(text);
    return result?.toolCalls?.length ? result : null;
  };

  return {
    promptInjectionDisabled: false,
    disabledPrompt: null,
    tools: normalizedTools,
    toolChoice: toolCallingEnabled ? effectiveToolChoice : 'none',
    toolCallingEnabled,
    triggerSignal,
    toolInstructions,
    parseToolCalls,
    parseToolCallsDetailed,
    createStreamDetector: () => toolCallingEnabled
      ? createXmlToolCallDetector({ triggerSignal, parseToolCalls, parseToolCallsDetailed })
      : null,
  };
}

function tagOpenAt(text, index, tag) {
  const match = String(text || '').slice(index).match(new RegExp(`^<${tag}\\b[^>]*>`, 'i'));
  return match ? { start: index, end: index + match[0].length, text: match[0] } : null;
}

function tagCloseAt(text, index, tag) {
  const match = String(text || '').slice(index).match(new RegExp(`^</${tag}\\s*>`, 'i'));
  return match ? { start: index, end: index + match[0].length, text: match[0] } : null;
}

function skipCdata(text, index) {
  if (!String(text || '').startsWith('<![CDATA[', index)) return null;
  const end = text.indexOf(']]>', index + '<![CDATA['.length);
  return end < 0 ? { truncated: true, end: text.length } : { truncated: false, end: end + ']]>'.length };
}

function findClosingTag(text, tag, fromIndex, skipTags = []) {
  const source = String(text || '');
  outer: for (let i = fromIndex; i < source.length; i++) {
    const cdata = skipCdata(source, i);
    if (cdata) {
      if (cdata.truncated) return null;
      i = cdata.end - 1;
      continue;
    }

    for (const skipTag of skipTags) {
      const skipOpen = tagOpenAt(source, i, skipTag);
      if (!skipOpen) continue;
      const skipClose = findClosingTag(source, skipTag, skipOpen.end, []);
      if (!skipClose) return null;
      i = skipClose.end - 1;
      continue outer;
    }

    const close = tagCloseAt(source, i, tag);
    if (close) return close;
  }
  return null;
}

function extractLeadingTagBlock(text, tag, skipTags = []) {
  const source = String(text || '');
  const open = tagOpenAt(source, 0, tag);
  if (!open) return null;
  const close = findClosingTag(source, tag, open.end, skipTags);
  if (!close) return { truncated: true, open, inner: source.slice(open.end), fullText: source };
  return {
    truncated: false,
    open,
    close,
    inner: source.slice(open.end, close.start),
    fullText: source.slice(0, close.end),
    end: close.end,
  };
}

function extractSequentialTagBlocks(text, tag, skipTags = []) {
  const source = String(text || '');
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;
    const open = tagOpenAt(source, i, tag);
    if (!open) return null;
    const close = findClosingTag(source, tag, open.end, skipTags);
    if (!close) return null;
    blocks.push(source.slice(open.end, close.start));
    i = close.end;
  }
  return blocks;
}

function findTriggerSignalsOutsideThink(text, triggerSignal) {
  if (!text || !triggerSignal) return [];
  const positions = [];
  let thinkDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const cdata = skipCdata(text, i);
    if (cdata) {
      if (cdata.truncated) break;
      i = cdata.end - 1;
      continue;
    }

    const argsOpen = tagOpenAt(text, i, 'args_json');
    if (argsOpen) {
      const argsClose = findClosingTag(text, 'args_json', argsOpen.end, []);
      if (argsClose) {
        i = argsClose.end - 1;
        continue;
      }
    }

    const thinkOpen = tagOpenAt(text, i, 'think');
    if (thinkOpen) {
      thinkDepth += 1;
      i = thinkOpen.end - 1;
      continue;
    }
    const thinkClose = tagCloseAt(text, i, 'think');
    if (thinkClose) {
      thinkDepth = Math.max(0, thinkDepth - 1);
      i = thinkClose.end - 1;
      continue;
    }
    if (thinkDepth === 0 && text.startsWith(triggerSignal, i)) {
      positions.push(i);
      i += triggerSignal.length - 1;
    }
  }
  return positions;
}

export function findLastTriggerSignalOutsideThink(text, triggerSignal) {
  const positions = findTriggerSignalsOutsideThink(text, triggerSignal);
  return positions.length ? positions[positions.length - 1] : -1;
}

function findProtocolTriggerSignal(text, triggerSignal) {
  const positions = findTriggerSignalsOutsideThink(text, triggerSignal);
  for (let i = positions.length - 1; i >= 0; i--) {
    const afterSignal = text.slice(positions[i] + triggerSignal.length).replace(/^\s*/, '');
    if (tagOpenAt(afterSignal, 0, 'function_calls')) return positions[i];
  }
  return positions.length ? positions[positions.length - 1] : -1;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractCdata(raw) {
  const text = String(raw || '');
  const cdataRx = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  const matches = [...text.matchAll(cdataRx)];
  if (matches.length) {
    const outside = text.replace(cdataRx, '').trim();
    if (outside) return null;
    return matches.map(match => match[1]).join('');
  }
  return decodeXmlEntities(text).trim();
}

function extractTagBody(block, tag) {
  const source = String(block || '');
  for (let i = 0; i < source.length; i++) {
    const open = tagOpenAt(source, i, tag);
    if (!open) continue;
    const close = findClosingTag(source, tag, open.end, tag === 'args_json' ? [] : ['args_json']);
    return close ? source.slice(open.end, close.start) : null;
  }
  return null;
}

function parseArgsJson(raw) {
  if (raw == null) return null;
  const extracted = extractCdata(raw);
  if (extracted == null) return null;
  const text = extracted.trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

export function parseXmlToolCallsDetailed(text, { triggerSignal, tools = [], toolChoice = 'auto' } = {}) {
  if (!text || !triggerSignal) {
    return { toolCalls: null, content: null, failureType: 'no_fc', errorDetails: 'No trigger signal configured or content is empty' };
  }
  const signalPos = findProtocolTriggerSignal(text, triggerSignal);
  if (signalPos < 0) {
    return { toolCalls: null, content: String(text || '') || null, failureType: 'no_fc', errorDetails: `Trigger signal '${triggerSignal}' not found outside <think> blocks` };
  }

  const prefix = text.slice(0, signalPos).trimEnd();
  const afterSignal = text.slice(signalPos + triggerSignal.length).replace(/^\s*/, '');
  const callsBlock = extractLeadingTagBlock(afterSignal, 'function_calls', ['args_json']);
  if (!callsBlock || callsBlock.truncated) {
    const failureType = tagOpenAt(afterSignal, 0, 'function_calls') ? 'truncated' : 'syntax_error';
    return { toolCalls: null, content: prefix || null, failureType, errorDetails: 'Missing complete <function_calls>...</function_calls> block after trigger', triggerIndex: signalPos };
  }
  if (afterSignal.slice(callsBlock.end).trim()) {
    return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: 'Unexpected text after </function_calls>', triggerIndex: signalPos };
  }

  const callBlocks = extractSequentialTagBlocks(callsBlock.inner, 'function_call', ['args_json']);
  if (!callBlocks || !callBlocks.length) {
    return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: callBlocks ? 'No <function_call> blocks found inside <function_calls>' : 'Malformed content inside <function_calls>; expected only complete <function_call> blocks', triggerIndex: signalPos };
  }

  const parsedTools = [];
  for (let i = 0; i < callBlocks.length; i++) {
    const block = callBlocks[i];
    const name = decodeXmlEntities(extractTagBody(block, 'tool') || '').trim();
    if (!name) {
      return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: `Tool call #${i + 1}: missing <tool> value`, triggerIndex: signalPos };
    }

    const argsBody = extractTagBody(block, 'args_json');
    const args = parseArgsJson(argsBody);
    if (args == null) {
      return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: `Tool call #${i + 1} '${name}': <args_json> must contain a valid JSON object`, triggerIndex: signalPos };
    }

    parsedTools.push({ name, args });
  }

  const validationError = validateParsedTools(parsedTools, tools, toolChoice);
  if (validationError) {
    return { toolCalls: null, content: prefix || null, failureType: 'schema_error', errorDetails: validationError, parsedTools, triggerIndex: signalPos };
  }

  const toolCalls = parsedTools.map((tool) => ({
    id: createInternalId('call'),
    type: 'function',
    function: {
      name: tool.name,
      arguments: JSON.stringify(tool.args || {}),
    },
  }));

  return {
    toolCalls,
    content: prefix || null,
    rawToolText: text.slice(signalPos, signalPos + triggerSignal.length + (text.slice(signalPos + triggerSignal.length).match(/^\s*/)?.[0]?.length || 0) + callsBlock.fullText.length),
    triggerIndex: signalPos,
    failureType: null,
    errorDetails: null,
  };
}

export function parseXmlToolCallsFromText(text, opts = {}) {
  const result = parseXmlToolCallsDetailed(text, opts);
  return result?.toolCalls?.length ? result : null;
}

function isPartialPatternAtEnd(buffer, index, patterns) {
  const rest = buffer.slice(index);
  if (patterns.some(pattern => rest.length < pattern.length && pattern.startsWith(rest))) return true;
  const lower = rest.toLowerCase();
  if ('<think'.startsWith(lower) || '</think'.startsWith(lower)) return true;
  if (/^<think\b[^>]*$/i.test(rest) || /^<\/think\s*$/i.test(rest)) return true;
  return false;
}

export function createXmlToolCallDetector({ triggerSignal, parseToolCalls, parseToolCallsDetailed = null }) {
  const patterns = [triggerSignal, '<think>', '</think>'].filter(Boolean);
  let state = 'detecting';
  let scanBuffer = '';
  let toolBuffer = '';
  let thinkDepth = 0;
  let completed = false;

  function buildParseFailure(base = {}, failureResult = null) {
    const bufferedToolText = toolBuffer;
    const result = failureResult || (parseToolCallsDetailed ? parseToolCallsDetailed(bufferedToolText) : null);
    state = 'passthrough';
    toolBuffer = '';
    return {
      ...base,
      delta: `${base.delta || ''}${bufferedToolText}`,
      parseFailure: true,
      bufferedToolText,
      failureType: result?.failureType || 'syntax_error',
      errorDetails: result?.errorDetails || 'Function-call XML could not be parsed',
      failureResult: result,
    };
  }

  function parseBufferedToolText(base = {}) {
    if (parseToolCallsDetailed) {
      const detailed = parseToolCallsDetailed(toolBuffer);
      if (detailed?.toolCalls?.length) {
        completed = true;
        return { ...base, completed: true, toolCalls: detailed.toolCalls, content: detailed.content || null };
      }
      if (detailed?.failureType === 'truncated') return base;
      if (detailed?.failureType === 'no_fc') return base;
      const afterTrigger = triggerSignal && toolBuffer.startsWith(triggerSignal)
        ? toolBuffer.slice(triggerSignal.length)
        : '';
      const afterTriggerTrimmed = afterTrigger.trimStart();
      const afterTriggerLower = afterTriggerTrimmed.toLowerCase();
      if (
        /^\s*$/.test(afterTrigger)
        || '<function_calls'.startsWith(afterTriggerLower)
        || /^<function_calls\b[^>]*$/i.test(afterTriggerTrimmed)
      ) return base;
      return buildParseFailure(base, detailed);
    }

    if (!/<\/function_calls\s*>/i.test(toolBuffer)) return base;
    const parsed = parseToolCalls(toolBuffer);
    if (parsed?.toolCalls?.length) {
      completed = true;
      return { ...base, completed: true, toolCalls: parsed.toolCalls, content: parsed.content || null };
    }
    state = 'passthrough';
    completed = true;
    return { ...base, delta: `${base.delta || ''}${toolBuffer}` };
  }

  return {
    process(chunk) {
      if (!chunk) return { delta: '' };
      if (completed) return { delta: '' };
      if (state === 'passthrough') return { delta: chunk };
      if (state === 'tool_parsing') {
        toolBuffer += chunk;
        return parseBufferedToolText({ delta: '' });
      }

      scanBuffer += chunk;
      let delta = '';
      let i = 0;

      while (i < scanBuffer.length) {
        const remaining = scanBuffer.slice(i);

        const thinkOpen = tagOpenAt(scanBuffer, i, 'think');
        if (thinkOpen) {
          thinkDepth += 1;
          delta += thinkOpen.text;
          i = thinkOpen.end;
          continue;
        }
        const thinkClose = tagCloseAt(scanBuffer, i, 'think');
        if (thinkClose) {
          thinkDepth = Math.max(0, thinkDepth - 1);
          delta += thinkClose.text;
          i = thinkClose.end;
          continue;
        }

        if (thinkDepth === 0 && triggerSignal && remaining.startsWith(triggerSignal)) {
          state = 'tool_parsing';
          toolBuffer = scanBuffer.slice(i);
          scanBuffer = '';
          return parseBufferedToolText({ delta });
        }

        if (isPartialPatternAtEnd(scanBuffer, i, patterns)) break;

        delta += scanBuffer[i];
        i += 1;
      }

      scanBuffer = scanBuffer.slice(i);
      return { delta };
    },

    finish() {
      if (completed) return { delta: '' };
      if (state === 'tool_parsing') {
        const parsed = parseToolCalls(toolBuffer);
        if (parsed?.toolCalls?.length) {
          completed = true;
          return { delta: '', completed: true, toolCalls: parsed.toolCalls, content: parsed.content || null };
        }
        if (parseToolCallsDetailed) {
          completed = true;
          return buildParseFailure({ delta: '' });
        }
        completed = true;
        return { delta: toolBuffer };
      }
      const tail = scanBuffer;
      scanBuffer = '';
      return { delta: tail };
    },
  };
}
