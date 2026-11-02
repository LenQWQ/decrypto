'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContent } = require('../lib/packs');

test('CSV/TXT：每行 4 个词会被解析成词组', () => {
  const parsed = parseContent('灯塔,蜂蜜,电梯,谎言\n火山、邮票、镜子、马拉松\n');
  assert.equal(parsed.sets.length, 2);
  assert.deepEqual(parsed.sets[0], ['灯塔', '蜂蜜', '电梯', '谎言']);
  assert.deepEqual(parsed.sets[1], ['火山', '邮票', '镜子', '马拉松']);
});

test('TXT：空格分隔和注释行', () => {
  const parsed = parseContent('# 我的题库\n星星 月亮 太阳 大海\n苹果 香蕉 橘子 葡萄\n');
  assert.equal(parsed.sets.length, 2);
});

test('TXT：每行一个词时作为词池', () => {
  const words = ['一', '二', '三', '四', '五', '六', '七', '八'];
  const parsed = parseContent(words.join('\n'));
  assert.equal(parsed.sets.length, 0);
  assert.equal(parsed.words.length, 8);
});

test('JSON：对象形式带 name / sets / words', () => {
  const parsed = parseContent(
    JSON.stringify({
      name: '间谍题库',
      sets: [['灯塔', '蜂蜜', '电梯', '谎言']],
      words: ['苹果', '香蕉', '橘子', '葡萄'],
    })
  );
  assert.equal(parsed.name, '间谍题库');
  assert.equal(parsed.sets.length, 1);
  assert.equal(parsed.words.length, 4);
});

test('JSON：纯词组数组', () => {
  const parsed = parseContent(
    JSON.stringify([
      ['灯塔', '蜂蜜', '电梯', '谎言'],
      ['火山', '邮票', '镜子', '马拉松'],
    ])
  );
  assert.equal(parsed.sets.length, 2);
});

test('不足 8 个不同的词会被拒绝', () => {
  assert.throws(() => parseContent('一\n二\n三\n四\n五\n六\n七'), /少于 8 个/);
});

test('同一组里有重复词会被拒绝', () => {
  assert.throws(
    () => parseContent('灯塔,灯塔,电梯,谎言\n火山,邮票,镜子,马拉松'),
    /重复/
  );
});

test('只有一组四词时，需要额外 4 个词', () => {
  assert.throws(
    () => parseContent('灯塔,蜂蜜,电梯,谎言\n苹果\n香蕉\n橘子'),
    /额外的单词/
  );

  const parsed = parseContent('灯塔,蜂蜜,电梯,谎言\n苹果\n香蕉\n橘子\n葡萄');
  assert.equal(parsed.sets.length, 1);
  assert.equal(parsed.words.length, 4);
});

test('空内容会被拒绝', () => {
  assert.throws(() => parseContent('   '), /为空/);
});
