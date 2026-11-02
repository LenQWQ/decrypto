'use strict';

/**
 * AI 加密 / AI 破译分析。
 *
 * 兼容任何 OpenAI Chat Completions 风格接口：
 *   AI_BASE_URL=https://api.deepseek.com/v1
 *   AI_API_KEY=sk-xxx
 *   AI_MODEL=deepseek-chat
 */

function isConfigured() {
  return Boolean(process.env.AI_API_KEY);
}

function modelName() {
  return process.env.AI_MODEL || 'deepseek-chat';
}

function baseUrl() {
  return (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
}

function timeoutMs() {
  const value = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 3000 ? value : 30000;
}

async function chat(messages, options = {}) {
  if (!isConfigured()) throw new Error('服务器未配置 AI_API_KEY');

  const { json = true, temperature = 0.9, maxTokens = 800 } = options;
  const url = `${baseUrl()}/chat/completions`;
  const body = {
    model: modelName(),
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const request = async (payload) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    return response;
  };

  let response;
  try {
    response = await request(body);
    // 部分兼容接口不支持 response_format，去掉后重试一次
    if (response.status === 400 && json) {
      delete body.response_format;
      response = await request(body);
    }
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? '请求超时' : '网络错误';
    throw new Error(`AI ${reason}，请稍后重试`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI 接口返回 ${response.status}：${text.slice(0, 160)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 没有返回内容');
  return content;
}

function parseJson(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI 返回的不是 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateClues(clues, keywords, archive) {
  if (!Array.isArray(clues) || clues.length !== 3) return '必须正好 3 条线索';

  for (let i = 0; i < clues.length; i += 1) {
    const clue = clues[i];
    if (!clue) return `第 ${i + 1} 条是空的`;
    if (clue.length > 16) return `第 ${i + 1} 条太长`;
    if (/[0-9０-９]/.test(clue)) return `第 ${i + 1} 条包含数字，容易泄露位置`;
    if (/第[一二三四]/.test(clue)) return `第 ${i + 1} 条提示了位置`;
    for (const keyword of keywords) {
      if (!keyword) continue;
      if (clue === keyword) return `第 ${i + 1} 条直接用了关键词`;
      if (keyword.length >= 2 && clue.includes(keyword)) {
        return `第 ${i + 1} 条包含完整关键词「${keyword}」`;
      }
    }
  }
  if (new Set(clues).size !== 3) return '三条线索重复';

  const history = new Set((archive || []).flat().map((entry) => entry.clue));
  if (clues.some((clue) => history.has(clue))) return '与历史线索重复';
  return '';
}

async function generateClues({ keywords, code, archive = [] }) {
  const keywordLines = keywords.map((word, index) => `${index + 1}. ${word}`).join('\n');
  const historyLines = archive
    .map((column, index) => {
      const recent = column.slice(-3).map((entry) => entry.clue);
      return `${index + 1} 号：${recent.length ? recent.join(' / ') : '（暂无）'}`;
    })
    .join('\n');

  const basePrompt = [
    '你是中文桌游《截码战》（Decrypto）的加密者。',
    '我方四个关键词（编号固定，对手看不到）：',
    keywordLines,
    '',
    `本轮密码：${code.join('-')}（三条线索必须严格按这个顺序给出）。`,
    '',
    '请为密码中的每个数字写一条中文线索，只输出 JSON：',
    '{"clues":["...","...","..."],"note":"一句话思路"}',
    '',
    '要求：',
    '- 每条线索必须与对应编号的关键词有清晰、可推理的语义关联，队友看到关键词后能对上；',
    '- 但不要过于直白，避免让对手一眼反推出关键词；',
    '- 不能出现完整关键词；不能提示字数、笔画、读音、外语翻译或屏幕位置；',
    '- 不能提到编号、数字、“第几个”；',
    '- 每条 2-10 个字，尽量具体、有画面感；',
    '- 三条线索之间不要互相暗示；',
    '- 避免重复历史线索。',
    '',
    '历史线索（仅供避开重复）：',
    historyLines,
  ].join('\n');

  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const suffix =
      attempt === 0
        ? ''
        : `\n\n上一版不合规：${lastProblem}。请重写，务必不要包含完整关键词。`;
    const raw = await chat(
      [
        { role: 'system', content: '你只输出合法 JSON，不要输出解释。' },
        { role: 'user', content: basePrompt + suffix },
      ],
      { json: true, temperature: 0.95 }
    );

    let data;
    try {
      data = parseJson(raw);
    } catch {
      lastProblem = '返回格式不是合法 JSON';
      continue;
    }
    if (!data || !Array.isArray(data.clues)) {
      lastProblem = '缺少 clues 数组';
      continue;
    }

    const clues = data.clues
      .slice(0, 3)
      .map((item) => String(item ?? '').replace(/\s+/g, ' ').trim());
    const problem = validateClues(clues, keywords, archive);
    if (!problem) {
      return { clues, note: String(data.note || '').slice(0, 120) };
    }
    lastProblem = problem;
  }

  throw new Error(`AI 生成的线索不合规：${lastProblem || '未知原因'}`);
}

async function analyzeArchive({ archive }) {
  const payload = archive.map((column, index) => ({
    number: index + 1,
    clues: column.map((entry) => entry.clue),
  }));

  const prompt = [
    '你在玩中文桌游《截码战》。下面是对手四个关键词（编号 1-4）在过往轮次里给出的全部线索。',
    '请根据线索推断每个编号最可能对应的中文关键词。',
    JSON.stringify(payload, null, 2),
    '',
    '只输出 JSON：',
    '{"guesses":[{"number":1,"word":"两个字的词","confidence":0.6,"reason":"简短理由"}],"summary":"整体判断"}',
    '要求：',
    '- 每个编号给一个最可能的词，尽量短（2-6 个字）；',
    '- confidence 是 0 到 1 之间的小数；',
    '- 如果线索太少无法判断，就给出猜测并说明不确定。',
  ].join('\n');

  const raw = await chat(
    [
      { role: 'system', content: '你是桌游猜词高手，只输出合法 JSON。' },
      { role: 'user', content: prompt },
    ],
    { json: true, temperature: 0.4, maxTokens: 700 }
  );

  const data = parseJson(raw);
  const guesses = Array.isArray(data.guesses)
    ? data.guesses
        .map((item) => ({
          number: Number(item?.number),
          word: String(item?.word || '').trim().slice(0, 12),
          confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0)),
          reason: String(item?.reason || '').slice(0, 80),
        }))
        .filter((item) => item.number >= 1 && item.number <= 4 && item.word)
    : [];

  if (!guesses.length) throw new Error('AI 没有给出有效推测');
  return {
    guesses,
    summary: String(data.summary || '').slice(0, 120),
  };
}

module.exports = {
  isConfigured,
  modelName,
  generateClues,
  analyzeArchive,
  validateClues,
  parseJson,
};
