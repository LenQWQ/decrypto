/**
 * Socket 冒烟测试：两个真实客户端跑完一轮。
 * 用法：先启动服务（PORT=3010），再 node test/smoke.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://127.0.0.1:3010';

function connect() {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true });
  socket.latest = null;
  socket.on('state', (state) => {
    socket.latest = state;
  });
  return socket;
}

function waitConnect(socket) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response || { ok: false }));
  });
}

function waitFor(socket, predicate, label, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (socket.latest && predicate(socket.latest)) {
        clearInterval(timer);
        resolve(socket.latest);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}`));
      }
    }, 30);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const a = connect();
const b = connect();

try {
  await Promise.all([waitConnect(a), waitConnect(b)]);

  const created = await emit(a, 'create', {
    name: '甲',
    packId: 'default',
    settings: { aiMode: 'off', maxRounds: 8 },
  });
  assert(created.ok, `创建房间失败：${created.error}`);
  console.log('创建房间', created.roomId);

  const joined = await emit(b, 'join', { name: '乙', roomId: created.roomId });
  assert(joined.ok, `加入房间失败：${joined.error}`);

  await waitFor(
    a,
    (state) => state.teams.A.players.length === 1 && state.teams.B.players.length === 1,
    '两人入座'
  );

  const started = await emit(a, 'start', {});
  assert(started.ok, `开始失败：${started.error}`);
  const encrypt = await waitFor(a, (state) => state.phase === 'encrypt', '进入加密');
  assert(encrypt.teams.A.keywords.length === 4, 'A 队关键词数量');
  assert(encrypt.teams.A.keywords.every(Boolean), 'A 队关键词非空');

  const cluesA = await emit(a, 'clues', { clues: ['线索甲一', '线索甲二', '线索甲三'] });
  assert(cluesA.ok, `A 提交线索失败：${cluesA.error}`);
  const cluesB = await emit(b, 'clues', { clues: ['线索乙一', '线索乙二', '线索乙三'] });
  assert(cluesB.ok, `B 提交线索失败：${cluesB.error}`);

  await waitFor(a, (state) => state.phase === 'intercept', '进入拦截');

  const interceptA = await emit(a, 'intercept', { code: [1, 2, 3] });
  assert(interceptA.ok, `A 拦截失败：${interceptA.error}`);
  const interceptB = await emit(b, 'intercept', { code: [1, 2, 3] });
  assert(interceptB.ok, `B 拦截失败：${interceptB.error}`);

  await waitFor(a, (state) => state.phase === 'decode', '进入破译');

  const decodeA = await emit(a, 'decode', { code: [4, 3, 2] });
  assert(decodeA.ok, `A 破译失败：${decodeA.error}`);
  const decodeB = await emit(b, 'decode', { code: [4, 3, 2] });
  assert(decodeB.ok, `B 破译失败：${decodeB.error}`);

  const reveal = await waitFor(
    a,
    (state) => state.phase === 'reveal' || state.phase === 'ended',
    '进入结算'
  );
  assert(reveal.lastReveal, '结算数据存在');
  assert(reveal.lastReveal.teams.A.code.length === 3, 'A 密码 3 位');
  assert(reveal.lastReveal.teams.B.code.length === 3, 'B 密码 3 位');
  assert(reveal.teams.A.archive.flat().length >= 3, 'A 档案已归档');
  console.log(
    '一轮完成，阶段：',
    reveal.phase,
    '比分白/黑：',
    reveal.teams.A.tokens,
    reveal.teams.B.tokens
  );

  // 未配置 AI 时，AI 推测关键词应返回明确错误
  const aiResult = await emit(a, 'ai_analyze', {});
  assert(aiResult.ok === false, '未配置 AI 时应返回错误');
  assert(/AI/.test(aiResult.error), '错误信息应提到 AI');
  console.log('AI 未配置时的提示：', aiResult.error);

  console.log('\n✅ 冒烟测试通过');
} finally {
  a.close();
  b.close();
}
