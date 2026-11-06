'use strict';

/**
 * 暗码行动 —— 服务端入口
 * Express（静态页面 + 题库 API） + Socket.IO（房间与对局）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

loadEnvFile(path.join(__dirname, '.env'));

const packs = require('./lib/packs');
const ai = require('./lib/ai');
const { GameRoom, GameError, PHASE, otherTeam } = require('./lib/room');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function loadEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function cleanNickname(name) {
  return String(name ?? '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Express                                                             */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '600kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, index: 'index.html' }));

const rooms = new Map();
const uploadHits = new Map();

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    rooms: rooms.size,
    aiConfigured: ai.isConfigured(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    ai: {
      configured: ai.isConfigured(),
      model: ai.isConfigured() ? ai.modelName() : '',
    },
    packCount: packs.listPacks().length,
  });
});

app.get('/api/packs', (req, res) => {
  res.json({ ok: true, packs: packs.listPacks().map(packs.summarize) });
});

app.post('/api/packs', (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (uploadHits.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (hits.length >= 30) {
      return res.status(429).json({ ok: false, error: '导入太频繁，请稍后再试' });
    }
    hits.push(now);
    uploadHits.set(ip, hits);

    const { name, content } = req.body || {};
    const pack = packs.importPack({ name, content });
    res.json({ ok: true, pack: packs.summarize(pack) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || '导入失败' });
  }
});

app.delete('/api/packs/:id', (req, res) => {
  try {
    if (!process.env.ADMIN_TOKEN) {
      return res
        .status(403)
        .json({ ok: false, error: '服务器未配置 ADMIN_TOKEN，已禁用删除题库' });
    }
    if (req.get('x-admin-token') !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: '管理口令不正确' });
    }
    packs.deletePack(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || '删除失败' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: '请求 JSON 格式错误' });
  }
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: '请求体太大' });
  }
  return next(error);
});

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
});

const socketContext = new Map(); // socket.id -> { roomId, playerId }
const aiUsage = new Map(); // playerId -> number[]

function roomKey(roomId) {
  return `room:${roomId}`;
}

function uniqueRoomId() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = '';
    for (let i = 0; i < 4; i += 1) {
      id += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(id)) return id;
  }
  throw new Error('房间号生成失败，请重试');
}

function attach(socket, room, playerId) {
  socket.join(roomKey(room.id));
  socketContext.set(socket.id, { roomId: room.id, playerId });
  socket.data.roomId = room.id;
  socket.data.playerId = playerId;
}

function detach(socket) {
  const context = socketContext.get(socket.id);
  socketContext.delete(socket.id);
  if (context) socket.leave(roomKey(context.roomId));
  socket.data.roomId = null;
  socket.data.playerId = null;
}

function contextOf(socket) {
  const context = socketContext.get(socket.id);
  if (!context) throw new GameError('你还没有加入房间');
  const room = rooms.get(context.roomId);
  if (!room) throw new GameError('房间不存在或已解散');
  const player = room.players.get(context.playerId);
  if (!player) throw new GameError('你不在这个房间');
  return { room, player, context };
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (!player.connected || !player.socketId) continue;
    io.to(player.socketId).emit('state', room.publicState(player.id));
  }
}

function handle(socket, event, handler) {
  socket.on(event, async (payload, callback) => {
    if (typeof payload === 'function') {
      callback = payload;
      payload = {};
    }
    try {
      const result = await handler(payload || {}, socket);
      if (typeof callback === 'function') callback({ ok: true, ...(result || {}) });
    } catch (error) {
      const message = error instanceof GameError ? error.message : error.message || '操作失败';
      if (!(error instanceof GameError)) console.error(`[${event}]`, error);
      if (typeof callback === 'function') callback({ ok: false, error: message });
      else socket.emit('notice', { type: 'error', text: message });
    }
  });
}

function limitAi(playerId, max, windowMs = 60_000) {
  const now = Date.now();
  const hits = (aiUsage.get(playerId) || []).filter((time) => now - time < windowMs);
  if (hits.length >= max) throw new GameError('AI 调用太频繁，请稍后再试');
  hits.push(now);
  aiUsage.set(playerId, hits);
}

function queueAutoEncrypt(room) {
  if (room.phase !== PHASE.ENCRYPT) return;

  for (const key of ['A', 'B']) {
    const team = room.teams[key];
    if (!team.aiEncrypt || team.submissions.clues || team.aiRunning) continue;

    if (!ai.isConfigured()) {
      if (room.fallbackAiToHuman(key)) {
        io.to(roomKey(room.id)).emit('notice', {
          type: 'error',
          text: '服务器未配置 AI，补偿加密无法触发，本轮改回人工加密。',
        });
        broadcast(room);
      }
      continue;
    }

    team.aiRunning = true;

    ai.generateClues({
      keywords: [...team.keywords],
      code: [...team.code],
      archive: team.archive.map((column) => column.map((entry) => ({ ...entry }))),
    })
      .then((result) => {
        room.submitAiClues(key, result.clues);
      })
      .catch((error) => {
        if (room.fallbackAiToHuman(key)) {
          io.to(roomKey(room.id)).emit('notice', {
            type: 'error',
            text: `AI 加密失败：${error.message}。本轮改回人工加密，请加密者手动写线索。`,
          });
        }
      })
      .finally(() => {
        team.aiRunning = false;
        broadcast(room);
      });
  }
}

/* ------------------------------------------------------------------ */
/* Socket 事件                                                         */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  handle(socket, 'create', (payload) => {
    const name = cleanNickname(payload.name);
    if (!name) throw new GameError('请先填写代号');
    const pack = packs.getPack(payload.packId) || packs.DEFAULT_PACK;
    const roomId = uniqueRoomId();
    const playerId = crypto.randomUUID();

    const room = new GameRoom({
      id: roomId,
      hostId: playerId,
      pack,
      settings: payload.settings,
    });
    room.addPlayer(playerId, name, socket.id);
    rooms.set(roomId, room);

    attach(socket, room, playerId);
    broadcast(room);
    return { roomId, playerId };
  });

  handle(socket, 'join', (payload) => {
    const roomId = String(payload.roomId || '').trim().toUpperCase();
    const name = cleanNickname(payload.name);
    if (!name) throw new GameError('请先填写代号');
    const room = rooms.get(roomId);
    if (!room) throw new GameError('房间不存在，检查一下房间号');

    const playerId = crypto.randomUUID();
    room.addPlayer(playerId, name, socket.id);
    attach(socket, room, playerId);
    broadcast(room);
    return { roomId: room.id, playerId };
  });

  handle(socket, 'rejoin', (payload) => {
    const roomId = String(payload.roomId || '').trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) throw new GameError('原房间已经不存在了');
    const player = room.players.get(String(payload.playerId || ''));
    if (!player) throw new GameError('你已经不在这个房间了');

    const oldSocketId = player.socketId;
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) oldSocket.disconnect(true);
    }
    player.socketId = socket.id;
    room.setConnected(player.id, true);
    attach(socket, room, player.id);
    broadcast(room);
    return { roomId: room.id, playerId: player.id };
  });

  handle(socket, 'leave', () => {
    const { room, player } = contextOf(socket);
    room.leave(player.id);
    detach(socket);
    broadcast(room);
    if (!room.players.size) rooms.delete(room.id);
    return {};
  });

  handle(socket, 'set_team', (payload) => {
    const { room, player } = contextOf(socket);
    room.setTeam(player.id, String(payload.team || '').toUpperCase());
    broadcast(room);
    return {};
  });

  handle(socket, 'start', () => {
    const { room, player } = contextOf(socket);
    room.start(player.id);
    broadcast(room);
    queueAutoEncrypt(room);
    return {};
  });

  handle(socket, 'clues', (payload) => {
    const { room, player } = contextOf(socket);
    room.submitClues(player.id, payload.clues);
    broadcast(room);
    return {};
  });

  handle(socket, 'intercept', (payload) => {
    const { room, player } = contextOf(socket);
    room.submitIntercept(player.id, payload.code);
    broadcast(room);
    return {};
  });

  handle(socket, 'decode', (payload) => {
    const { room, player } = contextOf(socket);
    room.submitDecode(player.id, payload.code);
    broadcast(room);
    return {};
  });

  handle(socket, 'next_round', () => {
    const { room, player } = contextOf(socket);
    room.nextRound(player.id);
    broadcast(room);
    queueAutoEncrypt(room);
    return {};
  });

  handle(socket, 'restart', () => {
    const { room, player } = contextOf(socket);
    room.restart(player.id);
    broadcast(room);
    return {};
  });

  handle(socket, 'ai_analyze', async () => {
    const { room, player } = contextOf(socket);
    const opponent = room.teams[otherTeam(player.team)];
    if (!opponent.archive.some((column) => column.length)) {
      throw new GameError('对手还没有任何历史线索');
    }
    limitAi(player.id, 4);
    return ai.analyzeArchive({
      archive: opponent.archive.map((column) => column.map((entry) => ({ ...entry }))),
    });
  });

  socket.on('disconnect', () => {
    const context = socketContext.get(socket.id);
    if (!context) return;
    socketContext.delete(socket.id);

    const room = rooms.get(context.roomId);
    if (!room) return;
    const player = room.players.get(context.playerId);
    if (player && player.socketId === socket.id) {
      room.setConnected(player.id, false);
      broadcast(room);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (!room.players.size) {
      rooms.delete(roomId);
      continue;
    }
    const allOffline = [...room.players.values()].every((player) => !player.connected);
    if (allOffline && now - room.updatedAt > 2 * 60 * 60 * 1000) rooms.delete(roomId);
  }
  for (const [playerId, hits] of aiUsage) {
    const recent = hits.filter((time) => now - time < 10 * 60 * 1000);
    if (recent.length) aiUsage.set(playerId, recent);
    else aiUsage.delete(playerId);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`暗码行动已启动：http://${HOST}:${PORT}`);
  console.log(`AI 加密：${ai.isConfigured() ? `已开启（${ai.modelName()}）` : '未配置（设置 AI_API_KEY 后可用）'}`);
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭…`);
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
