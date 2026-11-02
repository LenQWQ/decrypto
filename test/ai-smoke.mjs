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
  console.log('\n✅ AI 链路冒烟测试通过');
} finally {
  if (a) a.close();
  if (b) b.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => mock.close(resolve));
}
