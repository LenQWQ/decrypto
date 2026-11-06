'use strict';

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

const socket = io();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);

const PHASE_LABEL = {
  encrypt: '加密阶段',
  intercept: '拦截阶段',
  decode: '破译阶段',
  reveal: '本轮结算',
  ended: '对局结束',
};

const AI_MODE_LABEL = { off: '关闭', compensate: 'AI 补偿', auto: 'AI 全自动' };

let state = null;
let packs = [];
let config = { ai: { configured: false, model: '' } };
let identity = readSessionJson('decrypto.identity');
let nickname = localStorage.getItem('decrypto.nickname') || '';
let draftClues = { key: '', values: [] };
let draftPicks = { key: '', values: [] };
let aiAnalysis = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

socket.on('connect', () => {
  if (!identity) return;
  socket.emit('rejoin', identity, (res) => {
    if (!res || !res.ok) {
      identity = null;
      sessionStorage.removeItem('decrypto.identity');
      state = null;
      render();
      toast((res && res.error) || '原房间已失效', 'error');
    }
  });
});

socket.on('state', (next) => {
  state = next;
  render();
});

socket.on('notice', (notice) => {
  toast(notice.text || '提示', notice.type || 'info');
});

socket.on('disconnect', () => {
  toast('连接断开，正在重连…', 'error');
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
async function init() {
  const nameInput = $('#input-name');
  if (nameInput) nameInput.value = nickname;

  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) $('#input-code').value = roomParam.toUpperCase();

  bindEvents();

  try {
    await Promise.all([loadConfig(), loadPacks()]);
  } catch (error) {
    toast('初始化失败：' + error.message, 'error');
  }

  render();
}

function readSessionJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveIdentity(value) {
  identity = value;
  if (value) sessionStorage.setItem('decrypto.identity', JSON.stringify(value));
  else sessionStorage.removeItem('decrypto.identity');
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    event.preventDefault();
    handleAction(target.dataset.action, target).catch((error) => {
      toast(error.message || '操作失败', 'error');
    });
  });

  $('#input-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleAction('join', $('#input-code')).catch(() => {});
  });

  $('#input-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#input-code').focus();
  });
}

async function handleAction(action, element) {
  switch (action) {
    case 'create':
      return createRoom();
    case 'join':
      return joinRoom();
    case 'copy':
      return copyInvite();
    case 'start':
      return startGame();
    case 'switch-team':
      return checkAck(await emit('set_team', { team: element.dataset.team }));
    case 'leave':
      return leaveRoom();
    case 'home':
      return goHome();
    case 'submit-clues':
      return submitClues();
    case 'submit-intercept':
      return submitCode('intercept');
    case 'submit-decode':
      return submitCode('decode');
    case 'next-round':
      return checkAck(await emit('next_round', {}));
    case 'restart':
      return checkAck(await emit('restart', {}));
    case 'upload':
      return uploadPack(element);
    case 'refresh-packs':
      return loadPacks();
    case 'ai-analyze':
      return analyzeArchive(element);
    default:
      return undefined;
  }
}

function emit(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload || {}, (response) => resolve(response || { ok: false, error: '没有响应' }));
  });
}

function checkAck(response) {
  if (!response || !response.ok) throw new Error((response && response.error) || '操作失败');
  return response;
}

function currentNickname() {
  const input = $('#input-name');
  const raw = (input ? input.value : nickname).trim();
  const name = raw.slice(0, 12);
  if (!name) throw new Error('先取个代号吧');
  nickname = name;
  localStorage.setItem('decrypto.nickname', name);
  return name;
}

/* ------------------------------------------------------------------ */
/* 首页动作                                                            */
/* ------------------------------------------------------------------ */

async function createRoom() {
  const name = currentNickname();
  const settings = {
    aiMode: $('#select-ai') ? $('#select-ai').value : 'compensate',
    maxRounds: Number($('#select-rounds') ? $('#select-rounds').value : 8) || 8,
  };
  const packId = $('#select-pack') ? $('#select-pack').value : 'default';
  const res = checkAck(await emit('create', { name, packId, settings }));
  saveIdentity({ roomId: res.roomId, playerId: res.playerId });
}

async function joinRoom() {
  const name = currentNickname();
  const roomId = ($('#input-code').value || '').trim().toUpperCase();
  if (!roomId) throw new Error('请输入房间号');
  const res = checkAck(await emit('join', { name, roomId }));
  saveIdentity({ roomId: res.roomId, playerId: res.playerId });
  history.replaceState(null, '', `?room=${res.roomId}`);
}

async function startGame() {
  if (!state) return;
  if (state.teams.A.players.length < 2 || state.teams.B.players.length < 2) {
    const ok = await askConfirm(
      '开始游戏？',
      '有一队只有 1 名玩家：该队的加密者会同时看到密码，破译环节等于作弊，体验会明显变差。\n\n仍然开始？',
      '仍然开始'
    );
    if (!ok) return;
  }
  checkAck(await emit('start', {}));
}

async function leaveRoom() {
  if (state) await emit('leave', {});
  saveIdentity(null);
  state = null;
  aiAnalysis = null;
  history.replaceState(null, '', location.pathname);
  render();
}

async function goHome() {
  await leaveRoom();
}

async function copyInvite() {
  if (!state) return;
  const url = `${location.origin}/?room=${state.roomId}`;
  const ok = await copyText(url);
  toast(ok ? `邀请链接已复制：${url}` : url, ok ? 'success' : 'info');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 游戏动作                                                            */
/* ------------------------------------------------------------------ */

function draftKey() {
  return state ? `${state.roomId}:${state.round}:${state.phase}` : '';
}

function snapshotInputs() {
  if (!state) return;
  const key = draftKey();

  const clueInputs = $$('.clue-input');
  if (clueInputs.length === 3 && state.phase === 'encrypt') {
    draftClues = { key, values: clueInputs.map((input) => input.value) };
  }

  const picks = $$('.code-pick');
  if (picks.length === 3) {
    draftPicks = { key, values: picks.map((select) => select.value) };
  }
}

async function submitClues() {
  const inputs = $$('.clue-input');
  if (inputs.length !== 3) throw new Error('线索输入框没有准备好');
  const clues = inputs.map((input) => input.value.trim());
  if (clues.some((clue) => !clue)) throw new Error('三条线索都要填');
  const ok = await askConfirm(
    '确认提交线索？',
    `1. ${clues[0]}\n2. ${clues[1]}\n3. ${clues[2]}\n\n提交后本轮不能修改。`,
    '提交'
  );
  if (!ok) return;
  checkAck(await emit('clues', { clues }));
  draftClues = { key: '', values: [] };
}

async function submitCode(kind) {
  const picks = $$('.code-pick').map((select) => Number(select.value));
  if (picks.some((value) => !value)) throw new Error('请选择三个数字');
  if (new Set(picks).size !== 3) throw new Error('三个数字不能重复');

  const label = kind === 'intercept' ? '拦截' : '破译';
  const ok = await askConfirm(
    `确认提交${label}密码？`,
    `${picks.join('-')}\n\n提交后不能修改。`,
    '提交'
  );
  if (!ok) return;

  checkAck(await emit(kind, { code: picks }));
  draftPicks = { key: '', values: [] };
}

async function analyzeArchive(button) {
  const teamKey = button.dataset.team;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '推测中…';
  try {
    const res = checkAck(await emit('ai_analyze', {}));
    aiAnalysis = { key: analysisKey(teamKey), data: res };
    render();
    toast('AI 已给出关键词推测', 'success');
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    throw error;
  }
}

function analysisKey(teamKey) {
  return `${state.roomId}:${state.round}:${teamKey}`;
}

/* ------------------------------------------------------------------ */
/* 题库                                                                */
/* ------------------------------------------------------------------ */

async function loadPacks() {
  const res = await api('/api/packs');
  packs = res.packs || [];
  renderPackList();
}

async function loadConfig() {
  const res = await api('/api/config');
  config = res.ai ? res : { ai: { configured: false, model: '' } };
  const badge = $('#ai-badge');
  badge.hidden = false;
  if (config.ai.configured) {
    badge.className = 'badge online';
    badge.textContent = 'AI 就绪';
    badge.title = `模型：${config.ai.model || '默认'}`;
  } else {
    badge.className = 'badge ghost';
    badge.textContent = 'AI 未配置';
    badge.title = '在服务器 .env 里设置 AI_API_KEY 后可用；不影响手动加密';
  }

  const autoOption = $('#select-ai option[value="auto"]');
  if (autoOption && !config.ai.configured) {
    autoOption.disabled = true;
    autoOption.textContent = '全自动（需先配置 AI）';
  }
}

function renderPackList() {
  const count = $('#pack-count');
  if (count) count.textContent = `共 ${packs.length} 个题库`;

  const list = $('#pack-list');
  if (list) {
    list.innerHTML = packs
      .map(
        (pack) => `<div class="pack-item">
          <div>
            <div class="name">${esc(pack.name)} ${pack.builtin ? '<span class="pill">内置</span>' : ''}</div>
            <div class="meta">${pack.setCount} 组四词 · ${pack.wordCount} 个散词</div>
          </div>
        </div>`
      )
      .join('');
  }

  const select = $('#select-pack');
  if (select) {
    const previous = select.value;
    select.innerHTML = packs
      .map((pack) => `<option value="${esc(pack.id)}">${esc(pack.name)}（${pack.setCount || pack.wordCount}）</option>`)
      .join('');
    if (packs.some((pack) => pack.id === previous)) select.value = previous;
  }
}

async function uploadPack(button) {
  const fileInput = $('#file-pack');
  const textArea = $('#text-pack');
  const nameInput = $('#pack-name');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  let content = textArea ? textArea.value : '';
  if (file) {
    if (file.size > 512 * 1024) throw new Error('文件太大了（上限 512KB）');
    content = await file.text();
  }
  if (!content.trim()) throw new Error('请选择文件或粘贴题库内容');

  const original = button.textContent;
  button.disabled = true;
  button.textContent = '导入中…';
  try {
    const res = await api('/api/packs', {
      method: 'POST',
      body: JSON.stringify({
        name: nameInput ? nameInput.value.trim() : '',
        content,
      }),
    });
    toast(`题库「${res.pack.name}」导入成功`, 'success');
    if (textArea) textArea.value = '';
    if (fileInput) fileInput.value = '';
    if (nameInput) nameInput.value = '';
    await loadPacks();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render() {
  renderBadges();

  const home = $('#view-home');
  const room = $('#view-room');
  const game = $('#view-game');

  if (!state) {
    home.classList.remove('hidden');
    room.classList.add('hidden');
    game.classList.add('hidden');
    return;
  }

  if (state.status === 'lobby') {
    renderRoom();
    home.classList.add('hidden');
    room.classList.remove('hidden');
    game.classList.add('hidden');
  } else {
    renderGame();
    home.classList.add('hidden');
    room.classList.add('hidden');
    game.classList.remove('hidden');
  }
}

function renderBadges() {
  const badge = $('#me-badge');
  if (state && state.you) {
    badge.hidden = false;
    badge.textContent = `${state.you.name} · ${state.you.team} 队`;
  } else {
    badge.hidden = true;
  }
}

function otherTeam(teamKey) {
  return teamKey === 'A' ? 'B' : 'A';
}

function nameOf(team, playerId) {
  const player = (team.players || []).find((item) => item.id === playerId);
  return player ? player.name : '—';
}

function fmtCode(code) {
  return Array.isArray(code) ? code.join('-') : '—';
}

/* ---------------------------- 房间 ------------------------------- */

function renderRoom() {
  const you = state.you;
  const teamCard = (key) => {
    const team = state.teams[key];
    const mine = you.team === key;
    const rows = team.players.length
      ? team.players
          .map(
            (player) => `<div class="player-row">
              <span class="player-name">${esc(player.name)}
                ${player.id === you.id ? '<span class="you">你</span>' : ''}
                ${player.connected ? '' : '<span class="off">离线</span>'}
              </span>
            </div>`
          )
          .join('')
      : '<div class="empty">还没有人，喊朋友进来</div>';

    return `<div class="card team-card team-${key}">
      <div class="team-title">
        <h2>${key} 队</h2>
        <span class="tag">${team.players.length} 人</span>
      </div>
      ${rows}
      ${
        mine
          ? ''
          : `<button class="btn small ghost" data-action="switch-team" data-team="${key}" style="margin-top:10px">加入 ${key} 队</button>`
      }
    </div>`;
  };

  const startArea = you.isHost
    ? `<button class="btn primary" data-action="start">开始游戏</button>`
    : '<span class="muted small">等待房主开始…</span>';

  $('#view-room').innerHTML = `
    <div class="card room-head">
      <div>
        <div class="muted small">房间号</div>
        <div class="room-code">${esc(state.roomId)}</div>
      </div>
      <div class="actions">
        <button class="btn" data-action="copy">复制邀请链接</button>
      </div>
    </div>

    <div class="team-grid">
      ${teamCard('A')}
      ${teamCard('B')}
    </div>

    <div class="card room-foot">
      <div class="left">
        <span class="pill">${esc(state.pack.name)}</span>
        <span class="pill">${AI_MODE_LABEL[state.aiMode] || 'AI 补偿'}</span>
        <span class="pill">${state.maxRounds} 轮</span>
        <span class="muted small">建议每队 2 人以上</span>
      </div>
      <div class="actions">
        ${startArea}
        <button class="btn ghost" data-action="leave">离开</button>
      </div>
    </div>
  `;
}

/* ---------------------------- 游戏 ------------------------------- */

function renderGame() {
  snapshotInputs();

  const you = state.you;
  if (!you) {
    renderRoom();
    return;
  }
  const mine = state.teams[you.team];
  const opponent = state.teams[otherTeam(you.team)];

  $('#view-game').innerHTML = `
    ${gameHeader()}
    ${keywordStrip(mine, you.team)}
    ${roleLine(you, mine)}
    <div class="phase-wrap">${phasePanel(you, mine, opponent)}</div>
    ${archiveBlock(you.team, mine, true)}
    ${archiveBlock(otherTeam(you.team), opponent, false)}
  `;
}

function gameHeader() {
  const tokens = (team) =>
    `<span class="dot white"></span>${team.tokens.white}<span class="dot black" style="margin-left:8px"></span>${team.tokens.black}`;

  return `<div class="game-head">
    <div class="round-info">
      <span class="round-num">第 ${state.round} / ${state.maxRounds} 轮</span>
      <span class="phase-pill">${PHASE_LABEL[state.phase] || ''}</span>
      <span class="room-tag">房间 ${esc(state.roomId)}</span>
    </div>
    <div class="score-row">
      <span class="score-team"><span class="dot team-a"></span><b>A</b> ${tokens(state.teams.A)}</span>
      <span class="score-team"><span class="dot team-b"></span><b>B</b> ${tokens(state.teams.B)}</span>
      <button class="btn tiny ghost" data-action="copy">邀请</button>
    </div>
  </div>`;
}

function keywordStrip(team, teamKey) {
  const words = team.keywords || [];
  return `<div class="keyword-strip">
    ${[0, 1, 2, 3]
      .map(
        (index) => `<div class="keyword team-${teamKey}">
          <div class="num-badge">${index + 1}</div>
          <div>
            <div class="word">${words[index] ? esc(words[index]) : '·'}</div>
            <div class="hint">我方关键词</div>
          </div>
        </div>`
      )
      .join('')}
  </div>`;
}

function roleLine(you, team) {
  const aiEncrypt = Boolean(team.aiEncrypt);
  const encoder = aiEncrypt ? 'AI' : nameOf(team, team.encoderId);
  const role = aiEncrypt ? 'AI 补偿加密' : you.isEncoder ? '本轮加密者' : '破译者';
  return `<div class="role-line">
    <span class="pill ${you.team === 'A' ? 'teal' : 'rose'}">${you.team} 队</span>
    <span class="pill ${aiEncrypt || you.isEncoder ? 'gold' : ''}">${role}</span>
    <span>加密者：${esc(encoder)}</span>
    <span>·</span>
    <span>AI：${AI_MODE_LABEL[state.aiMode] || 'AI 补偿'}</span>
  </div>`;
}

function cluesCard(title, clues, note) {
  const list = clues || [];
  return `<div class="card clue-card">
    <div class="card-head">
      <h2>${esc(title)}</h2>
      <span class="muted small">${esc(note || '')}</span>
    </div>
    ${
      list.length
        ? list
            .map(
              (clue, index) => `<div class="clue-line">
                <span class="pos">${index + 1}</span>
                <span>${esc(clue)}</span>
              </div>`
            )
            .join('')
        : '<div class="empty">暂无</div>'
    }
  </div>`;
}

function waitingCard(title, subtitle, spinning = false) {
  return `<div class="card waiting-card">
    <h3>${spinning ? '<span class="spinner"></span>' : ''}${esc(title)}</h3>
    ${subtitle ? `<p class="muted small">${esc(subtitle)}</p>` : ''}
  </div>`;
}

function codePicksHtml() {
  const saved = draftPicks.key === draftKey() ? draftPicks.values : [];
  return `<div class="code-picks">
    ${[0, 1, 2]
      .map(
        (index) => `<select class="code-pick" data-idx="${index}">
          <option value="">?</option>
          ${[1, 2, 3, 4]
            .map(
              (number) =>
                `<option value="${number}" ${saved[index] === String(number) ? 'selected' : ''}>${number}</option>`
            )
            .join('')}
        </select>`
      )
      .join('<span class="sep">·</span>')}
  </div>`;
}

function phasePanel(you, mine, opponent) {
  switch (state.phase) {
    case 'encrypt':
      return encryptPanel(you, mine);
    case 'intercept':
      return interceptPanel(you, mine, opponent);
    case 'decode':
      return decodePanel(you, mine);
    case 'reveal':
    case 'ended':
      return revealPanel();
    default:
      return waitingCard('等待下一步…', '');
  }
}

function encryptPanel(you, team) {
  if (team.aiEncrypt) {
    if (team.submissions.clues) {
      return (
        cluesCard('AI 已提交线索', team.clues, '等待另一方…') +
        waitingCard('等待对手提交线索', '双方都提交后进入拦截阶段', true)
      );
    }
    const reason =
      state.aiMode === 'auto'
        ? '全自动模式：本轮由 AI 出线索'
        : '上轮本队破译失败，本轮触发 AI 补偿加密';
    return waitingCard('AI 正在为你们加密…', `${reason}；线索提交后全队一起破译`, true);
  }

  if (team.submissions.clues) {
    return (
      cluesCard('本轮线索已提交', team.clues, '等待另一方…') +
      waitingCard('等待对手提交线索', '双方都提交后进入拦截阶段', true)
    );
  }

  if (!you.isEncoder) {
    return waitingCard(
      `加密者 ${nameOf(team, team.encoderId)} 正在写线索`,
      '线索提交后，双方进入拦截阶段',
      true
    );
  }

  const code = team.code || [];
  if (code.length !== 3) return waitingCard('正在准备密码…', '', true);

  const saved = draftClues.key === draftKey() ? draftClues.values : [];
  return `<div class="card action">
    <div class="card-head">
      <h2>加密</h2>
      <span class="pill gold">你是本轮加密者</span>
    </div>
    <p class="muted small">按顺序为下面三个编号各写一条线索。队友要靠线索还原顺序，对手也会看到。</p>

    <div class="code-strip">
      ${code
        .map((number, index) => `${index ? '<span class="dot-sep">·</span>' : ''}<span class="code-num">${number}</span>`)
        .join('')}
    </div>

    <div class="clue-form">
      ${code
        .map(
          (number, index) => `<label class="clue-row">
            <span class="pos">${index + 1}</span>
            <span class="target">${number} 号</span>
            <input class="clue-input" data-i="${index}" maxlength="24"
              value="${esc(saved[index] || '')}" placeholder="线索 ${index + 1}">
          </label>`
        )
        .join('')}
    </div>

    <div class="actions">
      <button class="btn primary" data-action="submit-clues">提交线索</button>
    </div>
  </div>`;
}

function interceptPanel(you, mine, opponent) {
  const board = cluesCard(`拦截 ${otherTeam(you.team)} 队`, opponent.clues || [], '按密码顺序排列');

  if (mine.submissions.intercept) {
    return (
      board +
      waitingCard(`已提交拦截：${fmtCode(mine.guesses.intercept)}`, '等待对方提交与结算')
    );
  }

  return (
    board +
    `<div class="card action">
      <div class="card-head"><h2>推断密码</h2><span class="pill">全队讨论后提交</span></div>
      <p class="muted small">三条线索分别对应哪三个编号？按顺序选出来。猜对可获得一枚白色拦截标记，两次拦截成功直接获胜。</p>
      ${codePicksHtml()}
      <button class="btn primary" data-action="submit-intercept">提交拦截</button>
    </div>`
  );
}

function decodePanel(you, mine) {
  const board = cluesCard('我方本轮线索', mine.clues || [], '凭线索还原你们的密码');

  if (mine.submissions.decode) {
    return board + waitingCard(`已提交破译：${fmtCode(mine.guesses.decode)}`, '等待结算');
  }

  if (you.isEncoder && mine.players.length > 1) {
    return board + waitingCard('你是加密者', '本轮由队友完成破译，你不能参与');
  }

  return (
    board +
    `<div class="card action">
      <div class="card-head"><h2>破译自己的密码</h2><span class="pill">别让对手先猜中</span></div>
      <p class="muted small">根据本队三条线索，按顺序还原密码。破译失败会获得一枚黑色失误标记，两次失误直接输掉。</p>
      ${codePicksHtml()}
      <button class="btn primary" data-action="submit-decode">提交破译</button>
    </div>`
  );
}

function revealPanel() {
  const reveal = state.lastReveal;
  if (!reveal) {
    if (state.status === 'ended') return endedPanel('');
    return waitingCard('正在结算…', '', true);
  }

  const grid = `<div class="reveal-grid">${['A', 'B'].map((key) => revealTeamHtml(key)).join('')}</div>`;

  if (state.status === 'ended') return endedPanel(grid);

  return `<div class="card">
    <div class="card-head">
      <h2>本轮结算</h2>
      <span class="muted small">第 ${state.round} 轮</span>
    </div>
    ${grid}
    <div class="actions" style="margin-top:16px">
      ${
        state.you.isHost
          ? '<button class="btn primary" data-action="next-round">开始下一轮</button>'
          : '<span class="muted small">等待房主开始下一轮…</span>'
      }
    </div>
  </div>`;
}

function endedPanel(grid) {
  const score = (key) => state.teams[key].tokens.white - state.teams[key].tokens.black;
  const title = state.winner === 'draw' ? '平局' : `${state.winner} 队获胜`;
  const reason = state.endReason ? `（${state.endReason}）` : '';

  return `<div class="winner-banner">
      <h2>${title}</h2>
      <p>${esc(reason)}最终比分：A ${score('A')} : ${score('B')} B</p>
    </div>

    ${
      grid
        ? `<div class="card">
            <div class="card-head"><h2>最后一轮</h2></div>
            ${grid}
          </div>`
        : ''
    }

    <div class="card">
      <div class="card-head"><h2>全部关键词</h2></div>
      ${['A', 'B']
        .map(
          (key) => `<div class="role-line" style="margin-top:6px">
            <span class="pill ${key === 'A' ? 'teal' : 'rose'}">${key} 队</span>
            ${(state.teams[key].keywords || [])
              .map(
                (word, index) =>
                  `<span class="pill">${index + 1}. ${esc(word)}</span>`
              )
              .join('')}
          </div>`
        )
        .join('')}
    </div>

    <div class="card actions">
      ${state.you.isHost ? '<button class="btn primary" data-action="restart">再来一局</button>' : ''}
      <button class="btn ghost" data-action="home">返回首页</button>
    </div>`;
}

function revealTeamHtml(key) {
  const team = state.teams[key];
  const reveal = state.lastReveal.teams[key];
  if (!reveal) return '';

  return `<div class="reveal-team team-${key}">
    <div class="reveal-head">
      <b>${key} 队</b>
      <span class="muted small">${team.tokens.white} 白 / ${team.tokens.black} 黑</span>
    </div>
    <div class="reveal-code">
      ${reveal.code.map((number) => `<span class="code-num small">${number}</span>`).join('')}
    </div>
    <div class="reveal-clues">
      ${reveal.clues.map((clue, index) => `<div><span class="muted">${index + 1}.</span> ${esc(clue)}</div>`).join('')}
    </div>
    <div class="reveal-tags">
      <span class="tag ${reveal.decoded ? 'good' : 'bad'}">${reveal.decoded ? '破译成功' : '破译失败 +1 黑标'}</span>
      <span class="tag ${reveal.intercepted ? 'bad' : 'good'}">${reveal.intercepted ? '被对手拦截 +1 白标' : '未被拦截'}</span>
      ${reveal.aiEncrypted ? '<span class="tag">AI 补偿加密</span>' : ''}
      ${reveal.compensationNext ? '<span class="tag">下轮 AI 补偿</span>' : ''}
    </div>
  </div>`;
}

function archiveBlock(teamKey, team, isMine) {
  const analysis =
    aiAnalysis && aiAnalysis.key === analysisKey(teamKey) ? aiAnalysis.data : null;
  const canAnalyze =
    !isMine &&
    config.ai.configured &&
    state.status !== 'ended' &&
    (team.archive || []).some((column) => column.length);

  return `<div class="card archive">
    <div class="card-head">
      <h2>${isMine ? '我方' : '对手'}线索档案</h2>
      ${
        canAnalyze
          ? `<button class="btn tiny" data-action="ai-analyze" data-team="${teamKey}">AI 推测关键词</button>`
          : ''
      }
    </div>

    <div class="archive-grid">
      ${[0, 1, 2, 3]
        .map((index) => {
          const keyword = team.keywords ? team.keywords[index] : '';
          const list = (team.archive && team.archive[index]) || [];
          return `<div class="archive-col">
            <div class="num-badge">${index + 1}</div>
            ${keyword ? `<div class="kw">${esc(keyword)}</div>` : '<div class="kw unknown">?</div>'}
            <div class="clue-list">
              ${
                list.length
                  ? list
                      .map(
                        (entry) => `<div class="clue-item ${entry.author === 'AI' ? 'ai' : ''}">
                          <span class="r">R${entry.round}${entry.author === 'AI' ? ' · AI' : ''}</span>${esc(entry.clue)}
                        </div>`
                      )
                      .join('')
                  : '<div class="empty">—</div>'
              }
            </div>
          </div>`;
        })
        .join('')}
    </div>

    ${
      analysis
        ? `<div class="ai-result">
            <div class="muted small">AI 推测（仅供参考）</div>
            ${(analysis.guesses || [])
              .map(
                (guess) => `<div class="guess">
                  <b>${guess.number} 号</b>
                  <span>${esc(guess.word)}</span>
                  <span class="muted small">${Math.round((guess.confidence || 0) * 100)}%</span>
                </div>`
              )
              .join('')}
            ${analysis.summary ? `<div class="muted small" style="margin-top:6px">${esc(analysis.summary)}</div>` : ''}
          </div>`
        : ''
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 确认弹窗                                                            */
/* ------------------------------------------------------------------ */

function askConfirm(title, message, okText = '确认') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">
      <h3>${esc(title)}</h3>
      <p class="muted">${esc(message)}</p>
      <div class="actions">
        <button class="btn ghost" data-modal="cancel">取消</button>
        <button class="btn primary" data-modal="ok">${esc(okText)}</button>
      </div>
    </div>`;

    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };

    overlay.addEventListener('click', (event) => {
      const button = event.target.closest('[data-modal]');
      if (button) finish(button.dataset.modal === 'ok');
    });

    document.body.appendChild(overlay);
  });
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

function toast(text, type = 'info') {
  const element = $('#toast');
  if (!element) return;
  element.hidden = false;
  element.textContent = text;
  element.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 3600);
}
