const MIME_BY_EXT = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

function extensionFromName(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  return match?.[1] || '';
}

export function guessMimeType(filename = '', fallback = 'application/octet-stream') {
  return MIME_BY_EXT[extensionFromName(filename)] || fallback;
}

function filenameFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return name || fallback;
  } catch {
    return fallback;
  }
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2] || '', 'base64'),
  };
}

function normalizeBase64(value = '') {
  const text = String(value || '');
  const comma = text.indexOf(',');
  return text.startsWith('data:') && comma !== -1 ? text.slice(comma + 1) : text;
}

function fileKindForMime(mimeType = '', filename = '') {
  const mime = String(mimeType || '').toLowerCase();
  const ext = extensionFromName(filename);
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'amr'].includes(ext)) return 'audio';
  return 'file';
}

export function fileLabelForContentPart(part) {
  const file = part?.file || part?.input_file || part?.source || part || {};
  const filename = file.filename || file.name || part?.filename || part?.name || 'uploaded-file';
  return `[File: ${filename}]`;
}

function descriptorFromFilePart(part) {
  const file = part.file || part.input_file || part.source || {};
  const data = file.file_data ?? file.data ?? file.content ?? part.file_data ?? part.data;
  const url = file.url ?? file.uri ?? part.url;
  const filename = file.filename || file.name || part.filename || part.name || filenameFromUrl(url, 'uploaded-file');
  const mimeType = file.mime_type || file.media_type || file.type || part.mime_type || part.media_type || part.mimeType || guessMimeType(filename);

  if (!data && !url) return null;
  return {
    kind: fileKindForMime(mimeType, filename),
    filename,
    mimeType,
    data,
    url,
  };
}

function descriptorFromImageUrl(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (!url) return null;
  const data = parseDataUrl(url);
  const mimeType = data?.mimeType || guessMimeType(filenameFromUrl(url, 'image.png'), 'image/png');
  const ext = extensionFromName(filenameFromUrl(url, '')) || mimeType.split('/')[1] || 'png';
  return {
    kind: 'image',
    filename: filenameFromUrl(url, `image.${ext === 'jpeg' ? 'jpg' : ext}`),
    mimeType,
    url,
  };
}

export function collectUploadableParts(messages = []) {
  const files = [];
  for (const msg of messages || []) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== 'object') continue;
      let descriptor = null;
      if (part.type === 'image_url') descriptor = descriptorFromImageUrl(part);
      else if (part.type === 'file' || part.type === 'input_file') descriptor = descriptorFromFilePart(part);
      if (descriptor) files.push(descriptor);
    }
  }
  return files;
}

export function hasUploadableParts(messages = []) {
  return collectUploadableParts(messages).length > 0;
}

export async function resolveUploadableBytes(file, fetchImpl = fetch) {
  if (file.data) {
    const parsed = parseDataUrl(file.data);
    return {
      buffer: parsed?.buffer || Buffer.from(normalizeBase64(file.data), 'base64'),
      mimeType: parsed?.mimeType || file.mimeType || guessMimeType(file.filename),
    };
  }

  if (!file.url) throw new Error(`File ${file.filename || ''} has no data or URL`);
  const parsed = parseDataUrl(file.url);
  if (parsed) return { buffer: parsed.buffer, mimeType: parsed.mimeType };

  const res = await fetchImpl(file.url);
  if (!res.ok) throw new Error(`Failed to download file ${file.filename || file.url}: HTTP ${res.status}`);
  const mimeType = res.headers.get('content-type') || file.mimeType || guessMimeType(file.filename);
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

