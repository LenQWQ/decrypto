'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUILTIN_PACKS,
  listPacks,
  getPack,
  deletePack,
} = require('../lib/packs');

const THEME_IDS = [
  'wuxia',
  'scifi',
  'food',
  'workplace',
  'campus',
  'internet',
  'animals',
  'travel',
];

test('内置题库结构合法', () => {
  const ids = new Set();
  let totalSets = 0;
  let totalWords = 0;

  for (const pack of BUILTIN_PACKS) {
    assert.ok(pack.id, '题库缺少 id');
    assert.ok(pack.name, `${pack.id} 缺少名称`);
    assert.equal(pack.builtin, true, `${pack.id} 应标记为内置`);
    assert.ok(pack.sets.length >= 2, `${pack.id} 至少需要 2 组`);
    assert.equal(ids.has(pack.id), false, `内置题库 id 重复：${pack.id}`);
    ids.add(pack.id);

    const words = new Set();
    for (const [index, set] of pack.sets.entries()) {
      assert.equal(set.length, 4, `${pack.id} 第 ${index + 1} 组不是 4 个词`);
      assert.equal(
        new Set(set).size,
        4,
        `${pack.id} 第 ${index + 1} 组有重复词：${set.join('、')}`
      );
      for (const word of set) {
        assert.equal(typeof word, 'string');
        assert.ok(word.length >= 1 && word.length <= 16, `${pack.id} 词长异常：${word}`);
        words.add(word);
      }
    }

    assert.ok(words.size >= 8, `${pack.id} 不同词不足 8 个`);
    totalSets += pack.sets.length;
    totalWords += words.size;
  }

  assert.equal(BUILTIN_PACKS.length, 9, '应包含默认题库 + 8 个主题');
  assert.ok(totalSets >= 100, '内置题库总量偏少');
  assert.ok(totalWords >= 400, '内置词量偏少');
});

test('主题题库都能在列表中查到', () => {
  const ids = listPacks().map((pack) => pack.id);
  for (const id of THEME_IDS) {
    assert.ok(ids.includes(id), `列表缺少 ${id}`);
    const pack = getPack(id);
    assert.ok(pack, `getPack 找不到 ${id}`);
    assert.equal(pack.builtin, true);
    assert.equal(pack.id, id);
  }
});

test('每个主题至少 10 组四词', () => {
  for (const id of THEME_IDS) {
    const pack = getPack(id);
    assert.ok(pack.sets.length >= 10, `${pack.name} 只有 ${pack.sets.length} 组`);
  }
});

test('内置题库不能被删除', () => {
  for (const id of ['default', ...THEME_IDS]) {
    assert.throws(() => deletePack(id), /内置题库不能删除/);
  }
});
