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
    constraints.push('You MUST call at least one tool in this response.');
  }
  const forced = forcedToolName(toolChoice);
  if (forced) {
    constraints.push(`You MUST use only the tool named \`${forced}\`. Do not call any other tool.`);
  }

  const firstTool = normalized[0]?.function?.name || 'tool_name';
  const constraintText = constraints.length ? `\n\nTool choice constraints:\n${constraints.map(line => `- ${line}`).join('\n')}` : '';

  return `\n\nYou have access to the following available tools. Use them only when they are necessary to satisfy the user's request.

Available tools:
${renderToolList(normalized)}

When you need to call tools, you MUST output exactly this XML format:

${triggerSignal}
<function_calls>
  <function_call>
    <tool>${firstTool}</tool>
    <args_json><![CDATA[{"key":"value"}]]></args_json>
  </function_call>
</function_calls>

Rules:
- If no tool is needed, answer normally in plain text.
- The trigger signal must be on its own line exactly as shown.
- The trigger signal must appear only once.
- The first non-whitespace content after the trigger must be <function_calls>.
- Use one <function_calls> wrapper for all tool calls.
- Use one <function_call> block per tool call.
- The <tool> value must exactly match one declared tool name.
- The <args_json> value must contain a single JSON object with all arguments for that tool.
- You may wrap the JSON object in <![CDATA[...]]> to avoid XML escaping issues.
- Do not add explanations or any other text after </function_calls>.${constraintText}`;
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
