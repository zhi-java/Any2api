// Snapshot from chat.qwen.ai/api/models on 2026-07-03 using the configured
// QWEN_ACCOUNTS login. Keep this local by request; do not fetch models at
// runtime for /v1/models.
export const QWEN_BASE_MODELS = [
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus',
    capabilities: { vision: true, document: true, video: true, audio: true, thinking: true, search: true },
    chatTypes: ['t2t'],
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7-Max',
    capabilities: { document: true, thinking: true },
    chatTypes: ['t2t'],
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

function createModelMap() {
  const map = {};
  for (const rawModel of QWEN_BASE_MODELS) {
    const model = {
      ...rawModel,
      capabilities: capabilitiesFromModel(rawModel),
    };

    map[model.id] = {
      baseModel: model.id,
      name: model.name,
      mode: 'chat',
      capabilities: model.capabilities,
      chatTypes: model.chatTypes,
      chatMode: 't2t',
      forceThinking: false,
    };
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
  return {
    ...QWEN_MODEL_MAP[model],
    requestedModel: model,
    baseModel: model,
    chatMode: 't2t',
    forceThinking: false,
    mode: 'chat',
    modeCapabilities: {},
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
