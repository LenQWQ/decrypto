/**
 * AI 链路冒烟测试：
 * 起一个假的 OpenAI 兼容接口，再起一个配置了 AI 的游戏服，
 * 用 aiMode=auto 开局，验证两条线索会被自动生成并提交。
 *
 * 用法：node test/ai-smoke.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { io } from 'socket.io-client';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = 4099;
const GAME_PORT = 3011;
const MOCK_CLUES = ['清晨的雾', '海边的风', '旧照片'];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const payload = JSON.parse(body || '{}');
    const prompt = JSON.stringify(payload.messages || '');
    if (!prompt.includes('密码')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'prompt missing' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ clues: MOCK_CLUES, note: 'mock 线索' }),
            },
            finish_reason: 'stop',
          },
        ],
      })
    );
  });
});

await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(GAME_PORT),
    HOST: '127.0.0.1',
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    AI_API_KEY: 'test-key',
    AI_MODEL: 'mock-model',
    AI_TIMEOUT_MS: '5000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (data) => {
  serverLog += data;
});
child.stderr.on('data', (data) => {
  serverLog += data;
});

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function waitHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${GAME_PORT}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('游戏服启动超时\n' + serverLog);
}

function connect() {
  const socket = io(`http://127.0.0.1:${GAME_PORT}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  socket.latest = null;
  socket.on('state', (state) => {
    socket.latest = state;
  });
  return socket;
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response || { ok: false }));
  });
}

function waitFor(socket, predicate, label, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (socket.latest && predicate(socket.latest)) {
        clearInterval(timer);
        resolve(socket.latest);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}\n${serverLog}`));
      }
    }, 30);
  });
}

let a;
let b;

try {
  const health = await waitHealth();
  assert(health.aiConfigured === true, '健康检查应显示 AI 已配置');

  a = connect();
  b = connect();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const created = await emit(a, 'create', {
    name: '甲',
    packId: 'default',
    settings: { aiMode: 'auto', maxRounds: 8 },
  });
  assert(created.ok, `创建房间失败：${created.error}`);

  const joined = await emit(b, 'join', { name: '乙', roomId: created.roomId });
  assert(joined.ok, `加入房间失败：${joined.error}`);

  const started = await emit(a, 'start', {});
  assert(started.ok, `开始失败：${started.error}`);

  const intercept = await waitFor(
    a,
    (state) => state.phase === 'intercept',
    'AI 自动加密后进入拦截'
  );

  for (const key of ['A', 'B']) {
    const team = intercept.teams[key];
    assert(team.submissions.clues === true, `${key} 队线索应已自动提交`);
    assert(team.clues && team.clues.length === 3, `${key} 队应有 3 条线索`);
    assert(
      JSON.stringify(team.clues) === JSON.stringify(MOCK_CLUES),
      `${key} 队线索应来自 mock AI`
    );
  }

  console.log('AI 自动加密成功，当前阶段：', intercept.phase);
  console.log('线索：', intercept.teams.A.clues.join(' / '));

  // ===== 场景 2：A 队破译失败 -> 下一轮 AI 补偿 =====
  const c = connect();
  const d = connect();
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const room2 = await emit(c, 'create', {
      name: '丙',
      packId: 'default',
      settings: { aiMode: 'compensate', maxRounds: 8 },
    });
    assert(room2.ok, `补偿场景建房失败：${room2.error}`);
    assert((await emit(d, 'join', { name: '丁', roomId: room2.roomId })).ok, '补偿场景加入失败');
    assert((await emit(c, 'start', {})).ok, '补偿场景开局失败');

    const encrypt2 = await waitFor(
      c,
      (state) => state.phase === 'encrypt' && Array.isArray(state.teams.A.code),
      '补偿场景进入加密'
    );
    const codeA = encrypt2.teams.A.code;

    const viewB = await waitFor(
      d,
      (state) => state.phase === 'encrypt' && Array.isArray(state.teams.B.code),
      'B 队看到自己的密码'
    );
    const codeB = viewB.teams.B.code;

    assert((await emit(c, 'clues', { clues: ['丙线索一', '丙线索二', '丙线索三'] })).ok, 'A 提交线索失败');
    assert((await emit(d, 'clues', { clues: ['丁线索一', '丁线索二', '丁线索三'] })).ok, 'B 提交线索失败');
    await waitFor(c, (state) => state.phase === 'intercept', '补偿场景进入拦截');

    await emit(c, 'intercept', { code: [1, 2, 3] });
    await emit(d, 'intercept', { code: [1, 2, 3] });
    await waitFor(c, (state) => state.phase === 'decode', '补偿场景进入破译');

    // A 故意破译错（把三位轮换），B 正确
    assert(
      (await emit(c, 'decode', { code: [codeA[1], codeA[2], codeA[0]] })).ok,
      'A 提交错误破译失败'
    );
    assert((await emit(d, 'decode', { code: codeB })).ok, 'B 提交正确破译失败');

    const reveal2 = await waitFor(
      c,
      (state) => state.phase === 'reveal' || state.phase === 'ended',
      '补偿场景进入结算'
    );
    assert(reveal2.teams.A.tokens.black === 1, 'A 应记 1 个黑标');
    assert(reveal2.teams.A.compensationPending === true, 'A 应进入补偿待触发状态');

    assert((await emit(c, 'next_round', {})).ok, '进入补偿轮失败');
    const compensated = await waitFor(
      c,
      (state) => state.phase === 'encrypt' && state.teams.A.aiEncrypt === true,
      'A 队进入 AI 补偿加密'
    );
    assert(compensated.teams.A.encoderId === 'AI', '补偿轮加密者应为 AI');
    assert(compensated.teams.A.code === null, '补偿轮不应下发密码');
    assert(compensated.you.isEncoder === false, 'AI 加密时没有人类加密者');

    // B 仍人工，提交后等待 A 的 AI 线索
    assert((await emit(d, 'clues', { clues: ['丁二一', '丁二二', '丁二三'] })).ok, 'B 第二轮线索失败');
    const afterAi = await waitFor(c, (state) => state.phase === 'intercept', '补偿轮 AI 线索提交');
    assert(
      JSON.stringify(afterAi.teams.A.clues) === JSON.stringify(MOCK_CLUES),
      '补偿轮 A 队线索应来自 AI'
    );
    console.log('补偿轮 AI 线索：', afterAi.teams.A.clues.join(' / '));
  } finally {
    c.close();
    d.close();
  }

  console.log('\n✅ AI 链路冒烟测试通过');
} finally {
  if (a) a.close();
  if (b) b.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => mock.close(resolve));
}
