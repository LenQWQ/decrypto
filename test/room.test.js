'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, GameError, PHASE } = require('../lib/room');

const PACK = {
  id: 'test-pack',
  name: '测试题库',
  sets: [
    ['星星', '月亮', '太阳', '大海'],
    ['苹果', '香蕉', '橘子', '葡萄'],
    ['钢琴', '小提琴', '鼓', '笛子'],
    ['沙漠', '绿洲', '骆驼', '帐篷'],
  ],
  words: [],
};

function makeRoom(settings = {}, playerCount = 4) {
  const room = new GameRoom({
    id: 'TEST',
    hostId: 'p1',
    pack: PACK,
    settings: { aiMode: 'off', maxRounds: 8, ...settings },
  });
  const names = { p1: '甲', p2: '乙', p3: '丙', p4: '丁' };
  for (let i = 1; i <= playerCount; i += 1) {
    const id = `p${i}`;
    room.addPlayer(id, names[id], id);
  }
  return room;
}

function rotate(code) {
  return [code[1], code[2], code[0]];
}

function cluesFor(key) {
  return [`${key}线索甲`, `${key}线索乙`, `${key}线索丙`];
}

/** 找一名非加密者来破译 */
function decoderFor(room, key) {
  const team = room.teams[key];
  const player = team.players
    .map((id) => room.players.get(id))
    .find((item) => item && item.id !== team.encoderId);
  if (!player) throw new Error('没有可用的破译者');
  return player.id;
}

/**
 * 打完一轮。默认双方都破译正确、都没拦截成功。
 */
function playRound(room, options = {}) {
  const {
    aIntercepts = false,
    bIntercepts = false,
    aDecodes = true,
    bDecodes = true,
  } = options;
  const A = room.teams.A;
  const B = room.teams.B;

  room.submitClues(A.encoderId, cluesFor('A'));
  room.submitClues(B.encoderId, cluesFor('B'));
  assert.equal(room.phase, PHASE.INTERCEPT);

  room.submitIntercept(A.players[0], aIntercepts ? B.code : rotate(B.code));
  room.submitIntercept(B.players[0], bIntercepts ? A.code : rotate(A.code));
  assert.equal(room.phase, PHASE.DECODE);

  room.submitDecode(decoderFor(room, 'A'), aDecodes ? A.code : rotate(A.code));
  room.submitDecode(decoderFor(room, 'B'), bDecodes ? B.code : rotate(B.code));
  assert.ok(
    [PHASE.REVEAL, PHASE.ENDED].includes(room.phase),
    `一轮结束后应进入结算或结束，实际是 ${room.phase}`
  );
}

test('加入房间时自动分队，房主开局', () => {
  const room = makeRoom();
  assert.equal(room.hostId, 'p1');
  assert.deepEqual([...room.teams.A.players].sort(), ['p1', 'p3']);
  assert.deepEqual([...room.teams.B.players].sort(), ['p2', 'p4']);

  assert.throws(() => room.start('p2'), GameError, '只有房主可以开始');

  room.start('p1');
  assert.equal(room.status, 'playing');
  assert.equal(room.phase, PHASE.ENCRYPT);
  assert.equal(room.round, 1);

  for (const key of ['A', 'B']) {
    const keywords = room.teams[key].keywords;
    assert.equal(keywords.length, 4);
    assert.equal(new Set(keywords).size, 4);
  }
  const all = [...room.teams.A.keywords, ...room.teams.B.keywords];
  assert.equal(new Set(all).size, 8, '两队关键词不能重复');
});

test('加密者才能提交线索，且线索不能包含完整关键词', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;

  assert.throws(() => room.submitClues('p3', cluesFor('A')), /只有本队加密者/);

  const withKeyword = [...cluesFor('A')];
  withKeyword[0] = `关于${A.keywords[0]}的事`;
  assert.throws(() => room.submitClues(A.encoderId, withKeyword), /完整关键词/);

  assert.throws(() => room.submitClues(A.encoderId, ['一', '二']), /3 条/);

  room.submitClues(A.encoderId, cluesFor('A'));
  assert.equal(room.phase, PHASE.ENCRYPT, '只有一队提交还不能进入下一阶段');
  room.submitClues(room.teams.B.encoderId, cluesFor('B'));
  assert.equal(room.phase, PHASE.INTERCEPT);
});

test('不会把对手的关键词、密码、未公开线索泄露给玩家', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;
  const B = room.teams.B;
  room.submitClues(A.encoderId, cluesFor('A'));

  const asA = room.publicState('p1');
  const asB = room.publicState('p2');

  // A 队视角
  assert.deepEqual(asA.teams.A.keywords, A.keywords);
  assert.equal(asA.teams.B.keywords, null);
  assert.deepEqual(asA.teams.A.clues, cluesFor('A'));
  assert.equal(asA.teams.B.clues, null);
  assert.deepEqual(asA.teams.A.code, A.code, '加密者能看到自己的密码');
  assert.equal(asA.teams.B.code, null, '看不到对手密码');

  // B 队视角
  assert.equal(asB.teams.A.keywords, null);
  assert.deepEqual(asB.teams.B.keywords, B.keywords);
  assert.equal(asB.teams.A.clues, null, '对手还没提交完时，线索不可见');

  // 序列化后的状态里不能出现对手的关键词
  const wire = JSON.stringify(asA);
  for (const word of B.keywords) {
    assert.equal(wire.includes(word), false, `状态泄露了对手关键词：${word}`);
  }
});

test('完整一轮：破译失败记黑标，拦截成功记白标', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;
  const B = room.teams.B;

  playRound(room, {
    aIntercepts: true, // A 拦截 B 成功
    bIntercepts: false,
    aDecodes: true,
    bDecodes: false, // B 破译失败
  });

  assert.equal(A.tokens.white, 1);
  assert.equal(A.tokens.black, 0);
  assert.equal(B.tokens.white, 0);
  assert.equal(B.tokens.black, 1);

  const reveal = room.lastReveal;
  assert.equal(reveal.teams.B.intercepted, true);
  assert.equal(reveal.teams.B.decoded, false);
  assert.equal(reveal.teams.A.intercepted, false);

  // 线索按编号归档
  room.teams.A.code.forEach((number, index) => {
    const entry = room.teams.A.archive[number - 1].at(-1);
    assert.equal(entry.round, 1);
    assert.equal(entry.clue, cluesFor('A')[index]);
  });
});

test('两个白标直接获胜，且不能继续下一轮', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;

  playRound(room, { aIntercepts: true });
  assert.equal(room.phase, PHASE.REVEAL);
  assert.equal(room.status, 'playing');

  room.nextRound('p1');
  playRound(room, { aIntercepts: true });

  assert.equal(A.tokens.white, 2);
  assert.equal(room.status, 'ended');
  assert.equal(room.phase, PHASE.ENDED);
  assert.equal(room.winner, 'A');
  assert.throws(() => room.nextRound('p1'), /当前阶段/);
});

test('两个黑标直接失败，对手获胜', () => {
  const room = makeRoom();
  room.start('p1');

  playRound(room, { aDecodes: false });
  room.nextRound('p1');
  playRound(room, { aDecodes: false });

  assert.equal(room.teams.A.tokens.black, 2);
  assert.equal(room.status, 'ended');
  assert.equal(room.winner, 'B');
});

test('打满轮数按白标减黑标计分，平局为 draw', () => {
  const room = makeRoom({ maxRounds: 4 });
  room.start('p1');

  for (let round = 0; round < 4; round += 1) {
    playRound(room);
    if (round < 3) room.nextRound('p1');
  }

  assert.equal(room.round, 4);
  assert.equal(room.status, 'ended');
  assert.equal(room.winner, 'draw');
  assert.match(room.endReason, /轮数/);
});

test('结算后可以看到双方密码，但加密者不能参与本队破译', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;
  const B = room.teams.B;

  room.submitClues(A.encoderId, cluesFor('A'));
  room.submitClues(B.encoderId, cluesFor('B'));
  room.submitIntercept(A.players[0], rotate(B.code));
  room.submitIntercept(B.players[0], rotate(A.code));

  assert.throws(() => room.submitDecode(A.encoderId, A.code), /加密者不参与/);

  const asA = room.publicState('p1');
  assert.equal(asA.teams.B.code, null, '拦截阶段不能看到对手密码');

  room.submitDecode(decoderFor(room, 'A'), A.code);
  room.submitDecode(decoderFor(room, 'B'), B.code);

  const revealed = room.publicState('p1');
  assert.deepEqual(revealed.teams.B.code, B.code);
  assert.deepEqual(revealed.lastReveal.teams.A.code, A.code);
});

test('每队只有一人时允许加密者自己破译（仅用于测试流程）', () => {
  const room = makeRoom({}, 2);
  room.start('p1');
  const A = room.teams.A;
  const B = room.teams.B;

  room.submitClues(A.encoderId, cluesFor('A'));
  room.submitClues(B.encoderId, cluesFor('B'));
  room.submitIntercept(A.players[0], rotate(B.code));
  room.submitIntercept(B.players[0], rotate(A.code));
  room.submitDecode(A.encoderId, A.code);
  room.submitDecode(B.encoderId, B.code);

  assert.equal(room.phase, PHASE.REVEAL);
});

test('破译失败后下一轮由 AI 接管加密，且全队可破译', () => {
  const room = makeRoom({ aiMode: 'compensate' });
  room.start('p1');
  const A = room.teams.A;
  const B = room.teams.B;

  // 第一轮：A 破译失败
  playRound(room, { aDecodes: false });
  assert.equal(A.tokens.black, 1);
  assert.equal(A.compensation, true);
  assert.equal(B.compensation, false);

  room.nextRound('p1');
  assert.equal(A.aiEncrypt, true);
  assert.equal(A.encoderId, 'AI');
  assert.equal(A.humanEncoderId, 'p3', '第二轮原本轮到 p3 加密');
  assert.equal(B.aiEncrypt, false);
  assert.equal(B.encoderId, 'p4');

  // 人类不能替 AI 提交；AI 加密时没有人能看到密码
  assert.throws(() => room.submitClues('p3', cluesFor('A')), /AI 补偿/);
  const view = room.publicState('p3');
  assert.equal(view.teams.A.code, null);
  assert.equal(view.you.isEncoder, false);

  room.submitAiClues('A', cluesFor('A'));
  room.submitClues(B.encoderId, cluesFor('B'));
  assert.equal(room.phase, PHASE.INTERCEPT);

  room.submitIntercept(A.players[0], rotate(B.code));
  room.submitIntercept(B.players[0], rotate(A.code));
  assert.equal(room.phase, PHASE.DECODE);

  // AI 是加密者，名义上的加密者 p3 也可以参与破译
  room.submitDecode('p3', A.code);
  room.submitDecode(decoderFor(room, 'B'), B.code);
  assert.equal(room.phase, PHASE.REVEAL);

  // 补偿只作用一轮，下一轮恢复人工加密
  room.nextRound('p1');
  assert.equal(A.aiEncrypt, false);
  assert.notEqual(A.encoderId, 'AI');
  assert.equal(A.compensation, false);
});

test('AI 加密失败时能退回人工加密', () => {
  const room = makeRoom({ aiMode: 'compensate' });
  room.start('p1');
  playRound(room, { aDecodes: false });
  room.nextRound('p1');

  assert.equal(room.teams.A.aiEncrypt, true);
  assert.equal(room.fallbackAiToHuman('A'), true);
  assert.equal(room.teams.A.aiEncrypt, false);
  assert.equal(room.teams.A.encoderId, room.teams.A.humanEncoderId);

  room.submitClues(room.teams.A.encoderId, cluesFor('A'));
  room.submitClues(room.teams.B.encoderId, cluesFor('B'));
  assert.equal(room.phase, PHASE.INTERCEPT);
});

test('关闭 AI 时破译失败不会触发补偿', () => {
  const room = makeRoom({ aiMode: 'off' });
  room.start('p1');
  playRound(room, { aDecodes: false });

  assert.equal(room.teams.A.compensation, false);
  room.nextRound('p1');
  assert.equal(room.teams.A.aiEncrypt, false);
  assert.notEqual(room.teams.A.encoderId, 'AI');
});

test('全自动模式下每轮都由 AI 加密', () => {
  const room = makeRoom({ aiMode: 'auto' });
  room.start('p1');

  for (const key of ['A', 'B']) {
    assert.equal(room.teams[key].aiEncrypt, true);
    assert.equal(room.teams[key].encoderId, 'AI');
  }
});

test('重开一局会清空标记、档案和关键词', () => {
  const room = makeRoom({ maxRounds: 4 });
  room.start('p1');
  playRound(room, { aIntercepts: true });
  room.nextRound('p1');
  playRound(room);

  // 强制结束
  room._finishByScore('测试');
  assert.equal(room.status, 'ended');

  room.restart('p1');
  assert.equal(room.status, 'lobby');
  assert.equal(room.phase, PHASE.LOBBY);
  assert.equal(room.round, 0);
  assert.deepEqual(room.teams.A.tokens, { white: 0, black: 0 });
  assert.deepEqual(room.teams.A.archive, [[], [], [], []]);
  assert.deepEqual(room.teams.A.keywords, []);
});

test('加密者提交线索前离开，会由队友接替', () => {
  const room = makeRoom();
  room.start('p1');
  const A = room.teams.A;
  assert.equal(A.encoderId, 'p1');

  room.leave('p1');
  assert.equal(A.encoderId, 'p3');
  assert.equal(room.hostId, 'p2', '房主离开后移交给最早在线的玩家');
});
