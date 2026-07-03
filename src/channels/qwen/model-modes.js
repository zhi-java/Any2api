const MODE_SUFFIXES = [
  ['-deep-research', { chatMode: 'deep_research', mode: 'deep_research' }],
  ['-deep_research', { chatMode: 'deep_research', mode: 'deep_research' }],
  ['-image-edit', { chatMode: 'image_edit', mode: 'image_edit' }],
  ['-web-dev', { chatMode: 'web_dev', mode: 'webdev' }],
  ['-thinking', { chatMode: 't2t', forceThinking: true, mode: 'thinking' }],
  ['-artifacts', { chatMode: 'artifacts', mode: 'artifacts' }],
  ['-webdev', { chatMode: 'web_dev', mode: 'webdev' }],
  ['-search', { chatMode: 'search', mode: 'search' }],
  ['-travel', { chatMode: 'travel', mode: 'travel' }],
  ['-learn', { chatMode: 'learn', mode: 'learn' }],
  ['-image', { chatMode: 't2i', mode: 'image' }],
  ['-video', { chatMode: 't2v', mode: 'video' }],
  ['-slides', { chatMode: 'slides', mode: 'slides' }],
  ['-t2i', { chatMode: 't2i', mode: 'image' }],
  ['-t2v', { chatMode: 't2v', mode: 'video' }],
];

export function parseModelMode(modelId = '') {
  const requestedModel = String(modelId || '').trim();
  const lowered = requestedModel.toLowerCase();

  for (const [suffix, config] of MODE_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      return {
        requestedModel,
        baseModel: requestedModel.slice(0, -suffix.length),
        chatMode: config.chatMode,
        forceThinking: !!config.forceThinking,
        mode: config.mode,
      };
    }
  }

  return {
    requestedModel,
    baseModel: requestedModel,
    chatMode: 't2t',
    forceThinking: false,
    mode: 'chat',
  };
}

export function modelCapabilitiesForMode(mode) {
  const capabilities = {};
  if (mode.forceThinking) capabilities.thinking = true;
  if (mode.mode === 'deep_research') {
    capabilities.deep_research = true;
    capabilities.search = true;
  }
  if (mode.mode === 'image') capabilities.image_gen = true;
  if (mode.mode === 'image_edit') capabilities.image_edit = true;
  if (mode.mode === 'video') capabilities.video_gen = true;
  if (mode.mode === 'webdev') capabilities.web_dev = true;
  if (mode.mode === 'artifacts') capabilities.artifacts = true;
  if (mode.mode === 'search') capabilities.search = true;
  if (mode.mode === 'travel') capabilities.travel = true;
  if (mode.mode === 'learn') capabilities.learn = true;
  if (mode.mode === 'slides') capabilities.slides = true;
  return capabilities;
}
