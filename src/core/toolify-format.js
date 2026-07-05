import { InternalAPIError } from './errors.js';
import { normalizeToolArguments } from './internal-request.js';
import { textFromContent } from '../utils/response-utils.js';

function wrapCdata(text) {
  const safe = String(text || '').replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

function parseArgumentsObject(argumentsValue, toolName = 'tool') {
  if (argumentsValue == null || argumentsValue === '') return {};
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      throw new InternalAPIError(`Invalid assistant.tool_calls arguments for tool '${toolName}': ${err.message}`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_tool_arguments',
      });
    }
  }
  throw new InternalAPIError(`Invalid assistant.tool_calls arguments for tool '${toolName}': arguments must be a JSON object`, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_tool_arguments',
  });
}

function toolCallName(call) {
  return call?.function?.name || call?.name || '';
}

function toolCallArguments(call) {
  return call?.function?.arguments ?? call?.arguments ?? '{}';
}

export function buildToolCallIndexFromMessages(messages = []) {
  const index = new Map();
  for (const message of messages || []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = call?.id;
      const name = toolCallName(call);
      if (!id || !name) continue;
      const argsObject = parseArgumentsObject(toolCallArguments(call), name);
      index.set(id, {
        name,
        arguments: JSON.stringify(argsObject),
      });
    }
  }
  return index;
}

export function formatAssistantToolCallsForAI(toolCalls = [], triggerSignal) {
  if (!triggerSignal || !Array.isArray(toolCalls) || toolCalls.length === 0) return '';

  const xmlCalls = toolCalls.map(call => {
    const name = toolCallName(call);
    if (!name) {
      throw new InternalAPIError('Invalid assistant.tool_calls entry: missing tool name', {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_tool_call',
      });
    }
    const argsObject = parseArgumentsObject(toolCallArguments(call), name);
    const argsJson = JSON.stringify(argsObject);
    return `<function_call>\n<tool>${name}</tool>\n<args_json>${wrapCdata(argsJson)}</args_json>\n</function_call>`;
  }).join('\n');

  return `${triggerSignal}\n<function_calls>\n${xmlCalls}\n</function_calls>`;
}

export function formatToolResultForAI(toolName, toolArguments, resultContent) {
  return `Tool execution result:\n- Tool name: ${toolName}\n- Tool arguments: ${toolArguments || '{}'}\n- Execution result:\n<tool_result>\n${wrapCdata(resultContent ?? '')}\n</tool_result>`;
}

export function preprocessMessagesForToolify(messages = [], triggerSignal) {
  if (!triggerSignal) return messages || [];
  const toolCallIndex = buildToolCallIndexFromMessages(messages);
  const processed = [];

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') {
      processed.push(message);
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const originalText = textFromContent(message.content);
      const xml = formatAssistantToolCallsForAI(message.tool_calls, triggerSignal);
      const finalText = [originalText, xml].filter(Boolean).join('\n');
      const { tool_calls: _toolCalls, ...rest } = message;
      processed.push({
        ...rest,
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
      });
      continue;
    }

    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id || message.toolCallId;
      if (!toolCallId) {
        throw new InternalAPIError('Tool message missing tool_call_id', {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_tool_message',
        });
      }
      const toolInfo = toolCallIndex.get(toolCallId);
      if (!toolInfo) {
        throw new InternalAPIError(
          `tool_call_id=${toolCallId} not found in conversation history. Ensure the assistant message with this tool_call is included in the messages array.`,
          { status: 400, type: 'invalid_request_error', code: 'invalid_tool_message' },
        );
      }
      processed.push({
        role: 'user',
        content: [{
          type: 'text',
          text: formatToolResultForAI(toolInfo.name, toolInfo.arguments || normalizeToolArguments({}), textFromContent(message.content)),
        }],
      });
      continue;
    }

    processed.push(message);
  }

  return processed;
}
