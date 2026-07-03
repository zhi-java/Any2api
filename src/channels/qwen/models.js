import { modelCapabilitiesForMode, parseModelMode } from './model-modes.js';

// Snapshot from chat.qwen.ai/api/models on 2026-07-03 using the configured
// QWEN_ACCOUNTS login. Keep this local by request; do not fetch models at
// runtime for /v1/models.
export const QWEN_BASE_MODELS = [
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus',
    capabilities: { vision: true, document: true, video: true, audio: true, thinking: true, search: true },
    chatTypes: ['t2t', 't2v', 't2i', 'image_edit', 'search', 'artifacts', 'web_dev', 'deep_research', 'travel', 'learn', 'slides'],
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7-Max',
    capabilities: { document: true, thinking: true },
    chatTypes: ['t2t', 't2v', 't2i', 'image_edit', 'artifacts', 'search', 'web_dev', 'deep_research', 'travel', 'learn', 'slides'],
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen3.6-Plus',
    capabilities: { vision: true, document: true, video: true, audio: true, thinking: true, search: true },
    chatTypes: ['t2t', 't2v', 't2i', 'image_edit', 'search', 'artifacts', 'web_dev', 'deep_research', 'travel', 'learn', 'slides'],
  }
];

function capabilitiesFromModel(model) {
  const chatTypes = new Set(model.chatTypes || []);
  return {
    ...model.capabilities,
    search: Boolean(model.capabilities.search || chatTypes.has('search')),
    deep_research: chatTypes.has('deep_research'),
    image_gen: chatTypes.has('t2i'),
    image_edit: chatTypes.has('image_edit'),
    video_gen: chatTypes.has('t2v'),
    web_dev: chatTypes.has('web_dev'),
    artifacts: chatTypes.has('artifacts'),
    travel: chatTypes.has('travel'),
    learn: chatTypes.has('learn'),
    slides: chatTypes.has('slides'),
  };
}

function addVariant(map, model, suffix, mode, extraCapabilities = {}) {
  const capabilities = { ...model.capabilities, ...extraCapabilities };
  map[`${model.id}${suffix}`] = {
    baseModel: model.id,
    name: `${model.name}${suffix}`,
    mode,
    capabilities,
    chatTypes: model.chatTypes,
  };
}

function createModelMap() {
  const map = {};
  for (const rawModel of QWEN_BASE_MODELS) {
    const model = {
      ...rawModel,
      capabilities: capabilitiesFromModel(rawModel),
    };
    const chatTypes = new Set(model.chatTypes || []);

    map[model.id] = {
      baseModel: model.id,
      name: model.name,
      mode: 'chat',
      capabilities: model.capabilities,
      chatTypes: model.chatTypes,
    };

    if (model.capabilities.thinking) addVariant(map, model, '-thinking', 'thinking', { thinking: true });
    if (chatTypes.has('search')) addVariant(map, model, '-search', 'search', { search: true });
    if (chatTypes.has('deep_research')) addVariant(map, model, '-deep-research', 'deep_research', { deep_research: true, search: true });
    if (chatTypes.has('t2i')) addVariant(map, model, '-image', 'image', { image_gen: true });
    if (chatTypes.has('image_edit')) addVariant(map, model, '-image-edit', 'image_edit', { image_edit: true });
    if (chatTypes.has('t2v')) addVariant(map, model, '-video', 'video', { video_gen: true });
    if (chatTypes.has('artifacts')) addVariant(map, model, '-artifacts', 'artifacts', { artifacts: true });
    if (chatTypes.has('web_dev')) addVariant(map, model, '-webdev', 'webdev', { web_dev: true });
    if (chatTypes.has('travel')) addVariant(map, model, '-travel', 'travel', { travel: true });
    if (chatTypes.has('learn')) addVariant(map, model, '-learn', 'learn', { learn: true });
    if (chatTypes.has('slides')) addVariant(map, model, '-slides', 'slides', { slides: true });
  }
  return map;
}

export const QWEN_MODEL_MAP = createModelMap();

export function isQwenModel(model) {
  return Object.prototype.hasOwnProperty.call(QWEN_MODEL_MAP, model);
}

export function resolveModel(model) {
  if (!isQwenModel(model)) {
    throw new Error(`Unknown model: ${model}. Available: ${Object.keys(QWEN_MODEL_MAP).join(', ')}`);
  }
  const mode = parseModelMode(model);
  return {
    ...QWEN_MODEL_MAP[model],
    requestedModel: mode.requestedModel,
    baseModel: mode.baseModel,
    chatMode: mode.chatMode,
    forceThinking: mode.forceThinking,
    mode: mode.mode,
    modeCapabilities: modelCapabilitiesForMode(mode),
  };
}

export function listQwenModels() {
  return QWEN_BASE_MODELS.map((rawModel) => {
    const capabilities = capabilitiesFromModel(rawModel);
    return {
      id: rawModel.id,
      object: 'model',
      created: 1783000000,
      owned_by: 'qwen',
      name: rawModel.name,
      capabilities,
      chat_types: rawModel.chatTypes,
    };
  });
}

export function listQwenRoutableModels() {
  return Object.entries(QWEN_MODEL_MAP).map(([id, config]) => ({
    id,
    object: 'model',
    created: 1783000000,
    owned_by: 'qwen',
    name: config.name,
    capabilities: config.capabilities,
    chat_types: config.chatTypes,
  }));
}
