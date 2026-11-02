'use strict';

/**
 * 题库：内置默认题库 + 用户导入（JSON / TXT / CSV），落盘到 data/packs.json。
 *
 * 支持的格式：
 * 1) JSON 词组数组： [["灯塔","蜂蜜","电梯","谎言"], ...]
 * 2) JSON 单词数组： ["灯塔","蜂蜜", ...]
 * 3) JSON 对象： {"name":"我的题库","sets":[[...]],"words":[...]}
 * 4) 文本/CSV：每行 4 个词（逗号、空格、顿号、制表符分隔），或每行 1 个词
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PACKS_FILE = path.join(DATA_DIR, 'packs.json');
const MAX_CONTENT_LENGTH = 512 * 1024;
const MAX_WORD_LENGTH = 16;

const DEFAULT_SETS = [
  ['灯塔', '蜂蜜', '电梯', '谎言'],
  ['火山', '邮票', '镜子', '马拉松'],
  ['冰箱', '风筝', '律师', '潮汐'],
  ['沙漠', '口琴', '间谍', '年轮'],
  ['医院', '骰子', '瀑布', '密码'],
  ['森林', '咖啡', '望远镜', '婚礼'],
  ['月亮', '钥匙', '鲨鱼', '承诺'],
  ['雨伞', '棋盘', '蜡烛', '护照'],
  ['冰川', '火锅', '手机', '童话'],
  ['剧院', '蚂蚁', '地铁', '遗憾'],
  ['钟表', '蘑菇', '警察', '暑假'],
  ['气球', '图书馆', '台风', '秘密'],
  ['相机', '螃蟹', '加油站', '误会'],
  ['雪人', '小提琴', '迷宫', '谣言'],
  ['阳台', '蜜蜂', '程序员', '初恋'],
  ['帐篷', '章鱼', '高铁', '嫉妒'],
  ['灯泡', '骆驼', '超市', '勇气'],
  ['贝壳', '钢琴', '机场', '噩梦'],
  ['稻草人', '鲸鱼', '路由器', '乡愁'],
  ['烟花', '刺猬', '博物馆', '沉默'],
];

const DEFAULT_PACK = Object.freeze({
  id: 'default',
  name: '默认题库',
  builtin: true,
  sets: DEFAULT_SETS,
  words: [],
  createdAt: 0,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWord(word) {
  return String(word ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WORD_LENGTH);
}

function normalizeSet(set, index) {
  if (!Array.isArray(set)) throw new Error(`第 ${index + 1} 组不是数组`);
  const words = set.map(normalizeWord).filter(Boolean);
  if (words.length !== 4) throw new Error(`第 ${index + 1} 组必须正好 4 个词`);
  if (new Set(words).size !== 4) throw new Error(`第 ${index + 1} 组里有重复的词`);
  return words;
}

function loadUserPacks() {
  try {
    const raw = fs.readFileSync(PACKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (pack) =>
        isPlainObject(pack) &&
        typeof pack.id === 'string' &&
        typeof pack.name === 'string' &&
        Array.isArray(pack.sets) &&
        Array.isArray(pack.words)
    );
  } catch {
    return [];
  }
}

function saveUserPacks(packs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PACKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(packs, null, 2), 'utf8');
  fs.renameSync(tmp, PACKS_FILE);
}

function listPacks() {
  return [DEFAULT_PACK, ...loadUserPacks()];
}

function getPack(id) {
  if (!id) return DEFAULT_PACK;
  return listPacks().find((pack) => pack.id === id) || null;
}

function summarize(pack) {
  return {
    id: pack.id,
    name: pack.name,
    builtin: Boolean(pack.builtin),
    setCount: Array.isArray(pack.sets) ? pack.sets.length : 0,
    wordCount: Array.isArray(pack.words) ? pack.words.length : 0,
    totalWords:
      [...(pack.sets || []).flat(), ...(pack.words || [])].filter(Boolean).length,
  };
}

function parseJsonPack(data) {
  const result = { sets: [], words: [], name: '' };

  if (Array.isArray(data)) {
    if (data.every((item) => Array.isArray(item))) {
      result.sets = data;
    } else if (data.every((item) => typeof item === 'string')) {
      result.words = data;
    } else {
      throw new Error('JSON 数组需要是「四词组的数组」或「单词的数组」');
    }
    return result;
  }

  if (!isPlainObject(data)) throw new Error('JSON 结构无法识别');
  if (typeof data.name === 'string') result.name = data.name.trim().slice(0, 20);
  if (Array.isArray(data.sets)) result.sets = data.sets;
  if (Array.isArray(data.words)) result.words = data.words;
  if (!result.sets.length && !result.words.length) {
    throw new Error('JSON 里需要 sets 或 words 字段');
  }
  return result;
}

function parseTextPack(text) {
  const sets = [];
  const words = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line
      .split(/[,，、\t|;；]+|\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= 4) {
      sets.push(parts.slice(0, 4));
    } else if (parts.length) {
      words.push(...parts);
    }
  }
  return { sets, words, name: '' };
}

function parseContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('题库内容为空');
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error('题库文件太大（上限 512KB）');
  }

  const text = content.replace(/\r\n/g, '\n').trim();
  let parsed;
  if (text.startsWith('{') || text.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON 解析失败，请检查括号和引号');
    }
    parsed = parseJsonPack(data);
  } else {
    parsed = parseTextPack(text);
  }

  const sets = parsed.sets.map(normalizeSet);
  const seen = new Set();
  const words = [];
  for (const word of parsed.words) {
    const normalized = normalizeWord(word);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    words.push(normalized);
  }

  if (sets.length === 1) {
    const pool = new Set(sets[0]);
    const extra = words.filter((word) => !pool.has(word));
    if (extra.length < 4) {
      throw new Error('只有 1 组四词时，还需要至少 4 个额外的单词给第二队');
    }
  }

  // 两组关键词必须不同，否则双方会互相知道底牌
  const distinct = new Set([...sets.flat(), ...words]);
  if (distinct.size < 8) {
    throw new Error('题库里的不同词少于 8 个，无法组成两队的四个关键词');
  }
  if (!sets.length && words.length < 8) {
    throw new Error('至少需要 8 个单词，或 2 组四词');
  }

  if (!sets.length && !words.length) throw new Error('没有解析出任何词');
  return { name: parsed.name, sets, words };
}

function importPack({ name, content }) {
  const parsed = parseContent(content);
  const userPacks = loadUserPacks();
  const finalName = String(name || parsed.name || '未命名题库').trim().slice(0, 20);

  const pack = {
    id: `p_${crypto.randomBytes(4).toString('hex')}`,
    name: finalName || '未命名题库',
    builtin: false,
    sets: parsed.sets,
    words: parsed.words,
    createdAt: Date.now(),
  };

  userPacks.push(pack);
  saveUserPacks(userPacks);
  return pack;
}

function deletePack(id) {
  if (!id || id === 'default') throw new Error('内置题库不能删除');
  const userPacks = loadUserPacks();
  const next = userPacks.filter((pack) => pack.id !== id);
  if (next.length === userPacks.length) throw new Error('题库不存在');
  saveUserPacks(next);
  return true;
}

module.exports = {
  DEFAULT_PACK,
  DATA_DIR,
  listPacks,
  getPack,
  importPack,
  deletePack,
  parseContent,
  summarize,
};
