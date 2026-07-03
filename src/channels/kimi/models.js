export const KIMI_MODEL_MAP = {
  'kimi-k2.6': {
    name: 'Kimi K2.6',
    scenario: 'SCENARIO_K2D5',
    thinking: false,
    capabilities: { thinking: true, search: true },
  },
  'kimi-k2.6-thinking': {
    name: 'Kimi K2.6 Thinking',
    scenario: 'SCENARIO_K2D5',
    thinking: true,
    capabilities: { thinking: true, search: true },
  },
};

export function isKimiModel(model) {
  return Object.prototype.hasOwnProperty.call(KIMI_MODEL_MAP, model);
}

export function resolveModel(model) {
  if (!isKimiModel(model)) {
    throw new Error(`Unknown Kimi model: ${model}. Available: ${Object.keys(KIMI_MODEL_MAP).join(', ')}`);
  }
  return {
    requestedModel: model,
    ...KIMI_MODEL_MAP[model],
  };
}

export function listKimiModels() {
  return Object.entries(KIMI_MODEL_MAP).map(([id, config]) => ({
    id,
    object: 'model',
    created: 1783000000,
    owned_by: 'kimi',
    name: config.name,
    capabilities: config.capabilities,
  }));
}
