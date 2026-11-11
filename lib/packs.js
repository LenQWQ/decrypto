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

/* ------------------------------------------------------------------ */
/* 内置主题题库                                                        */
/* ------------------------------------------------------------------ */

const THEME_PACKS = [
  {
    id: 'wuxia',
    name: '武侠江湖',
    sets: [
      ['剑法', '内功', '轻功', '暗器'],
      ['掌门', '长老', '弟子', '叛徒'],
      ['客栈', '镖局', '山寨', '衙门'],
      ['秘籍', '丹药', '毒药', '解药'],
      ['少林', '武当', '峨眉', '丐帮'],
      ['华山', '悬崖', '山洞', '竹林'],
      ['侠客', '书生', '乞丐', '和尚'],
      ['比武', '闭关', '走火入魔', '顿悟'],
      ['长剑', '折扇', '拂尘', '双节棍'],
      ['江湖', '恩怨', '承诺', '背叛'],
      ['点穴', '易容', '传音', '御剑'],
      ['师父', '师娘', '师兄', '仇人'],
    ],
  },
  {
    id: 'scifi',
    name: '科幻宇宙',
    sets: [
      ['黑洞', '虫洞', '曲率', '反物质'],
      ['飞船', '母舰', '太空站', '休眠舱'],
      ['外星人', '机器人', '克隆人', '人工智能'],
      ['激光', '护盾', '引擎', '燃料'],
      ['火星', '月球', '土星', '银河'],
      ['时间旅行', '平行宇宙', '末日', '未来'],
      ['全息', '虚拟现实', '脑机接口', '意识上传'],
      ['宇航员', '舰长', '科学家', '叛军'],
      ['陨石', '辐射', '失重', '真空'],
      ['星际', '殖民', '探索', '信号'],
      ['基因', '病毒', '变异', '解冻'],
      ['无人机', '探测器', '望远镜', '雷达'],
    ],
  },
  {
    id: 'food',
    name: '舌尖美食',
    sets: [
      ['火锅', '烧烤', '麻辣烫', '串串'],
      ['奶茶', '咖啡', '豆浆', '酸梅汤'],
      ['小笼包', '煎饼', '油条', '包子'],
      ['螺蛳粉', '臭豆腐', '榴莲', '香菜'],
      ['烤鸭', '烧鹅', '白切鸡', '红烧肉'],
      ['月饼', '粽子', '汤圆', '年糕'],
      ['辣椒', '花椒', '生姜', '大蒜'],
      ['醋', '酱油', '盐', '糖'],
      ['冰淇淋', '蛋糕', '布丁', '泡芙'],
      ['夜宵', '外卖', '下馆子', '大排档'],
      ['菜单', '厨师', '锅铲', '围裙'],
      ['米其林', '私房菜', '路边摊', '自助餐'],
    ],
  },
  {
    id: 'workplace',
    name: '职场打工人',
    sets: [
      ['周报', '例会', '加班', '打卡'],
      ['绩效', '年终奖', '晋升', '裁员'],
      ['简历', '面试', '跳槽', '背调'],
      ['甲方', '需求', '改稿', '上线'],
      ['工位', '电脑', '工牌', '会议室'],
      ['摸鱼', '甩锅', '背锅', '内卷'],
      ['团建', '聚餐', '敬酒', '领导'],
      ['实习', '转正', 'offer', '离职'],
      ['工资', '社保', '公积金', '个税'],
      ['钉钉', '邮件', '群聊', '已读'],
      ['出差', '报销', '发票', '预算'],
      ['996', '福报', '躺平', '副业'],
    ],
  },
  {
    id: 'campus',
    name: '校园青春',
    sets: [
      ['早读', '课间', '晚自习', '放学'],
      ['班主任', '班长', '同桌', '转学生'],
      ['作业', '考试', '成绩', '排名'],
      ['食堂', '宿舍', '操场', '小卖部'],
      ['校服', '红领巾', '书包', '文具盒'],
      ['运动会', '广播操', '升旗', '班会'],
      ['情书', '暗恋', '表白', '分手'],
      ['毕业', '合影', '同学录', '散伙饭'],
      ['寒暑假', '补课', '夏令营', '家长会'],
      ['粉笔', '黑板', '讲台', '课桌'],
      ['图书馆', '实验室', '篮球场', '校门口'],
      ['迟到', '罚站', '请家长', '记过'],
    ],
  },
  {
    id: 'internet',
    name: '赛博网络',
    sets: [
      ['弹幕', '热搜', '表情包', '点赞'],
      ['直播', '带货', '打赏', '榜一'],
      ['算法', '推荐', '流量', '限流'],
      ['键盘侠', '网暴', '人肉', '举报'],
      ['破防', '社死', '玩梗', '造梗'],
      ['元宇宙', '虚拟人', '数字藏品', '区块链'],
      ['短视频', '竖屏', '滤镜', '美颜'],
      ['评论区', '转发', '收藏', '已读不回'],
      ['网盘', '链接', '提取码', '压缩包'],
      ['密码', '验证码', '实名', '绑定'],
      ['会员', '广告', '弹窗', '免密'],
      ['群主', '管理员', '禁言', '踢人'],
    ],
  },
  {
    id: 'animals',
    name: '动物世界',
    sets: [
      ['考拉', '树懒', '鸭嘴兽', '穿山甲'],
      ['企鹅', '海豹', '鲸鱼', '章鱼'],
      ['蜂鸟', '萤火虫', '蜻蜓', '蝴蝶'],
      ['犀牛', '河马', '长颈鹿', '大象'],
      ['狼', '狐狸', '兔子', '刺猬'],
      ['猫', '狗', '仓鼠', '鹦鹉'],
      ['鳄鱼', '蟒蛇', '蜥蜴', '乌龟'],
      ['蚂蚁', '蜜蜂', '白蚁', '蜘蛛'],
      ['熊猫', '金丝猴', '朱鹮', '扬子鳄'],
      ['迁徙', '冬眠', '换毛', '求偶'],
    ],
  },
  {
    id: 'travel',
    name: '旅行地图',
    sets: [
      ['护照', '签证', '登机牌', '行李箱'],
      ['民宿', '酒店', '青旅', '露营地'],
      ['攻略', '地图', '导航', '迷路'],
      ['日出', '日落', '星空', '云海'],
      ['高铁', '飞机', '轮船', '自驾'],
      ['时差', '汇率', '插座', '转换头'],
      ['景点', '门票', '排队', '拍照'],
      ['纪念品', '明信片', '冰箱贴', '土特产'],
      ['背包', '帐篷', '睡袋', '登山杖'],
      ['海边', '雪山', '沙漠', '古镇'],
    ],
  },
];

const BUILTIN_PACKS = [
  {
    id: 'default',
    name: '默认题库',
    builtin: true,
    sets: DEFAULT_SETS,
    words: [],
    createdAt: 0,
  },
  ...THEME_PACKS.map((pack) => ({
    id: pack.id,
    name: pack.name,
    builtin: true,
    sets: pack.sets,
    words: [],
    createdAt: 0,
  })),
];

const DEFAULT_PACK = Object.freeze(BUILTIN_PACKS[0]);

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
  return [...BUILTIN_PACKS, ...loadUserPacks()];
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
  const target = listPacks().find((pack) => pack.id === id);
  if (!target) throw new Error('题库不存在');
  if (target.builtin) throw new Error('内置题库不能删除');

  const userPacks = loadUserPacks();
  const next = userPacks.filter((pack) => pack.id !== id);
  if (next.length === userPacks.length) throw new Error('题库不存在');
  saveUserPacks(next);
  return true;
}

module.exports = {
  DEFAULT_PACK,
  BUILTIN_PACKS,
  DATA_DIR,
  listPacks,
  getPack,
  importPack,
  deletePack,
  parseContent,
  summarize,
};
