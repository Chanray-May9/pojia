/**
 * 目标模型目录：发帖时可标注"针对哪个模型"。
 * 只收录模型家族（避免版本号快速过时）；用户可用 "其他" + 自定义文本补充。
 */
export const MODELS = [
  { id: 'gpt', label: 'OpenAI GPT 系列', vendor: 'OpenAI' },
  { id: 'claude', label: 'Anthropic Claude 系列', vendor: 'Anthropic' },
  { id: 'gemini', label: 'Google Gemini 系列', vendor: 'Google' },
  { id: 'llama', label: 'Meta Llama 系列', vendor: 'Meta' },
  { id: 'qwen', label: '阿里通义千问 Qwen', vendor: 'Alibaba' },
  { id: 'deepseek', label: 'DeepSeek 系列', vendor: 'DeepSeek' },
  { id: 'mistral', label: 'Mistral 系列', vendor: 'Mistral AI' },
  { id: 'glm', label: '智谱 GLM 系列', vendor: 'Zhipu' },
  { id: 'kimi', label: '月之暗面 Kimi', vendor: 'Moonshot' },
  { id: 'doubao', label: '字节豆包', vendor: 'ByteDance' },
  { id: 'ernie', label: '百度文心 ERNIE', vendor: 'Baidu' },
  { id: 'other', label: '其他 / 自定义', vendor: '' },
];

export const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

export const MAX_MODELS_PER_THREAD = 3;

/** 解析并校验客户端提交的模型标注，返回 { models: string[], error?: string } */
export function parseModels(input) {
  let list = input;
  if (typeof input === 'string') list = input.split(',');
  if (!Array.isArray(list)) list = [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? '').trim().toLowerCase();
    if (!id) continue;
    if (!MODEL_MAP.has(id)) return { models: [], error: `未知的模型标识：${id}` };
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > MAX_MODELS_PER_THREAD) {
    return { models: [], error: `最多标注 ${MAX_MODELS_PER_THREAD} 个模型` };
  }
  return { models: out };
}

/** 展示用：把存储的 id 列表换成可读标签 */
export function modelLabels(ids) {
  if (!ids) return [];
  const list = Array.isArray(ids) ? ids : String(ids).split(',');
  return list
    .map((id) => MODEL_MAP.get(String(id).trim()))
    .filter(Boolean)
    .map((m) => m.label);
}
