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

export function getToolErrorRetryPrompt(originalResponse, errorDetails, triggerSignal) {
  return `Your previous response attempted to make a function call but the format was invalid or could not be parsed.

Your original response:
\`\`\`
${originalResponse}
\`\`\`

Error details:
${errorDetails}

Instructions:
Please retry and output the function call in the correct XML format. Remember:
1. Start with the trigger signal on its own line exactly as: ${triggerSignal}
2. Immediately follow with the <function_calls> XML block
3. Use <args_json> with valid JSON object parameters
4. The arguments must match the declared tool schema
5. Do not add any text after </function_calls>

Please provide the corrected function call now. DO NOT OUTPUT ANYTHING ELSE.`;
}

export function getToolContinuationPrompt(truncatedContent, errorDetails) {
  const tail = String(truncatedContent || '').slice(-1500);
  return `Your previous response was cut off before the function call XML was complete.

Your truncated response:
\`\`\`
${tail}
\`\`\`

What happened:
${errorDetails}

You have two options:

Option A (PREFERRED — Continue writing):
Output ONLY the exact continuation from where you were cut off. Rules:
- Start EXACTLY from the next character after the cutoff point — do not repeat any text.
- If the cutoff happened mid-word, start from the next character of that word.
- Do NOT output any trigger signal or opening tags that were already present.
- End with the proper closing tags (</function_call>, </function_calls> as needed).
- Do NOT add any explanation before or after.

Option B (Only if you made an error earlier):
Start fresh with the complete function call from the trigger signal. Output the trigger signal on its own line, followed by the complete function_calls block.

Choose Option A unless you believe your previous output contained errors that need correction.`;
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
      : getToolErrorRetryPrompt(currentContent, errorDetails, promptPlan.triggerSignal);

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
