'use strict';

/**
 * 房间与对局状态机（与网络层完全解耦，方便单测）。
 *
 * 规则参考《截码战 / 谍报风云》：
 * - 每队 4 个关键词（编号 1-4，对手不可见）
 * - 每轮每队随机生成 3 位密码（1-4 不重复），由本队加密者写 3 条线索
 * - 对方根据本轮线索尝试“拦截”密码；本队（除加密者）尝试“破译”密码
 * - 破译失败：本队 +1 黑色失误标记；被对手拦截：对手 +1 白色拦截标记
 * - 任意一队 2 个白标直接获胜；任意一队 2 个黑标直接失败
 * - 打满上限轮数按 白标 - 黑标 计分
 */

const PHASE = Object.freeze({
  LOBBY: 'lobby',
  ENCRYPT: 'encrypt',
  INTERCEPT: 'intercept',
  DECODE: 'decode',
  REVEAL: 'reveal',
  ENDED: 'ended',
});

const TEAM_KEYS = Object.freeze(['A', 'B']);
const MAX_PLAYERS = 8;
const MAX_CLUE_LEN = 24;
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 20;

class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}

function otherTeam(key) {
  return key === 'A' ? 'B' : 'A';
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomCode() {
  return shuffle([1, 2, 3, 4]).slice(0, 3);
}

function isCode(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => Number.isInteger(n) && n >= 1 && n <= 4) &&
    new Set(value).size === 3
  );
}

function sameCode(a, b) {
  return isCode(a) && isCode(b) && a.every((n, i) => n === b[i]);
}

function cleanName(name) {
  const text = String(name ?? '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
  return text || '无名氏';
}

function cloneClues(clues) {
  return Array.isArray(clues) ? clues.map((c) => String(c)) : null;
}

class GameRoom {
  constructor({ id, hostId, pack, settings = {} }) {
    if (!id) throw new GameError('缺少房间号');
    if (!pack || !pack.id) throw new GameError('缺少题库');

    this.id = id;
    this.hostId = hostId;
    this.pack = { id: pack.id, name: pack.name || '未命名题库' };
    this.packData = {
      id: pack.id,
      name: pack.name || '未命名题库',
      sets: Array.isArray(pack.sets) ? pack.sets.map((s) => [...s]) : [],
      words: Array.isArray(pack.words) ? [...pack.words] : [],
    };
    this.settings = {
      aiMode: ['off', 'assist', 'auto'].includes(settings.aiMode) ? settings.aiMode : 'assist',
      maxRounds: Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Number(settings.maxRounds) || 8)),
    };

    this.players = new Map();
    this.teams = { A: this._newTeam('A'), B: this._newTeam('B') };
    this.status = 'lobby';
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.winner = null;
    this.endReason = '';
    this.lastReveal = null;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  _newTeam(key) {
    return {
      key,
      players: [],
      keywords: [],
      encoderId: null,
      encoderCursor: 0,
      code: null,
      clues: null,
      clueAuthor: null,
      guesses: { intercept: null, decode: null },
      submissions: { clues: false, intercept: false, decode: false },
      tokens: { white: 0, black: 0 },
      archive: [[], [], [], []],
      aiRunning: false,
    };
  }

  _touch() {
    this.updatedAt = Date.now();
  }

  _assertPhase(phase) {
    if (this.phase !== phase) throw new GameError('当前阶段不能执行这个操作');
  }

  _playerTeam(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new GameError('你不在这个房间');
    return { player, team: this.teams[player.team] };
  }

  _teamPlayers(key) {
    return this.teams[key].players
      .map((id) => this.players.get(id))
      .filter(Boolean);
  }

  _firstConnected() {
    for (const player of this.players.values()) {
      if (player.connected) return player.id;
    }
    return '';
  }

  addPlayer(id, name, socketId) {
    if (this.players.size >= MAX_PLAYERS) throw new GameError('房间已满（最多 8 人）');
    if (this.status !== 'lobby') throw new GameError('游戏已经开始，无法中途加入');
    if (this.players.has(id)) throw new GameError('你已经在房间里');

    const team = this.teams.A.players.length <= this.teams.B.players.length ? 'A' : 'B';
    const player = {
      id,
      name: cleanName(name),
      team,
      connected: true,
      socketId,
      joinedAt: Date.now(),
    };
    this.players.set(id, player);
    this.teams[team].players.push(id);
    this._touch();
    return player;
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = Boolean(connected);
    this._touch();
  }

  setTeam(playerId, teamKey) {
    if (this.status !== 'lobby') throw new GameError('开局后不能换队');
    if (!TEAM_KEYS.includes(teamKey)) throw new GameError('无效的队伍');
    const player = this.players.get(playerId);
    if (!player) throw new GameError('你不在这个房间');
    if (player.team === teamKey) return;

    const oldTeam = this.teams[player.team];
    oldTeam.players = oldTeam.players.filter((id) => id !== playerId);
    this.teams[teamKey].players.push(playerId);
    player.team = teamKey;
    this._touch();
  }

  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    const team = this.teams[player.team];
    const wasEncoder = team.encoderId === playerId;
    this.players.delete(playerId);
    team.players = team.players.filter((id) => id !== playerId);

    if (this.hostId === playerId) {
      this.hostId = this._firstConnected();
    }

    if (this.status === 'playing') {
      const aEmpty = this.teams.A.players.length === 0;
      const bEmpty = this.teams.B.players.length === 0;
      if (aEmpty || bEmpty) {
        this.status = 'ended';
        this.phase = PHASE.ENDED;
        this.winner = aEmpty && bEmpty ? 'draw' : aEmpty ? 'B' : 'A';
        this.endReason = '有队伍成员全部离开';
      } else if (wasEncoder && this.phase === PHASE.ENCRYPT && !team.submissions.clues) {
        // 加密者在提交线索前离开，交给下一位队友
        const next = this._teamPlayers(team.key).find((p) => p.id !== playerId);
        if (next) team.encoderId = next.id;
      }
    }

    this._touch();
  }

  start(playerId) {
    if (playerId !== this.hostId) throw new GameError('只有房主可以开始游戏');
    if (this.phase !== PHASE.LOBBY) throw new GameError('游戏已经开始');
    if (!this.teams.A.players.length || !this.teams.B.players.length) {
      throw new GameError('两边都至少要有一名玩家');
    }

    this._assignKeywords();
    this.status = 'playing';
    this.winner = null;
    this.endReason = '';
    this.round = 0;
    this.startRound();
  }

  _assignKeywords() {
    const usedWords = new Set();
    const usedSets = new Set();
    for (const key of TEAM_KEYS) {
      const picked = sampleFourWords(this.packData, usedWords, usedSets);
      this.teams[key].keywords = picked;
    }
  }

  startRound() {
    const nextRound = this.round + 1;
    if (nextRound > this.settings.maxRounds) {
      this._finishByScore('轮数用尽');
      return;
    }

    this.round = nextRound;
    this.phase = PHASE.ENCRYPT;
    this.lastReveal = null;

    for (const key of TEAM_KEYS) {
      const team = this.teams[key];
      const players = this._teamPlayers(key);
      if (!players.length) throw new GameError(`${key} 队没有玩家`);

      const encoder = players[team.encoderCursor % players.length];
      team.encoderCursor = (team.encoderCursor + 1) % players.length;
      team.encoderId = encoder.id;
      team.code = randomCode();
      team.clues = null;
      team.clueAuthor = null;
      team.guesses = { intercept: null, decode: null };
      team.submissions = { clues: false, intercept: false, decode: false };
      team.aiRunning = false;
    }
    this._touch();
  }

  _validateClues(clues, keywords) {
    if (!Array.isArray(clues) || clues.length !== 3) {
      throw new GameError('需要提交正好 3 条线索');
    }
    const cleaned = clues.map((item, index) => {
      const text = String(item ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) throw new GameError(`第 ${index + 1} 条线索不能为空`);
      if (text.length > MAX_CLUE_LEN) {
        throw new GameError(`第 ${index + 1} 条线索最多 ${MAX_CLUE_LEN} 个字`);
      }
      return text;
    });

    for (const [index, clue] of cleaned.entries()) {
      for (const keyword of keywords) {
        if (!keyword) continue;
        if (clue === keyword) {
          throw new GameError(`第 ${index + 1} 条线索直接使用了关键词「${keyword}」`);
        }
        if (keyword.length >= 2 && clue.includes(keyword)) {
          throw new GameError(`第 ${index + 1} 条线索包含完整关键词「${keyword}」`);
        }
      }
    }
    if (new Set(cleaned).size !== 3) throw new GameError('三条线索不能重复');
    return cleaned;
  }

  submitClues(playerId, clues, author = 'human') {
    this._assertPhase(PHASE.ENCRYPT);
    const { team } = this._playerTeam(playerId);
    if (playerId !== team.encoderId && author !== 'AI') {
      throw new GameError('只有本队加密者可以提交线索');
    }
    if (team.submissions.clues) throw new GameError('本轮线索已经提交过了');

    team.clues = this._validateClues(clues, team.keywords);
    team.clueAuthor = author;
    team.submissions.clues = true;
    this._touch();
    this._advanceIfReady();
    return team.clues;
  }

  submitIntercept(playerId, code) {
    this._assertPhase(PHASE.INTERCEPT);
    const { team } = this._playerTeam(playerId);
    if (team.submissions.intercept) throw new GameError('本队已经提交拦截');
    if (!isCode(code)) throw new GameError('密码必须是 1-4 中三个不重复的数字');
    team.guesses.intercept = code.map(Number);
    team.submissions.intercept = true;
    this._touch();
    this._advanceIfReady();
  }

  submitDecode(playerId, code) {
    this._assertPhase(PHASE.DECODE);
    const { team } = this._playerTeam(playerId);
    if (team.submissions.decode) throw new GameError('本队已经提交破译');
    if (playerId === team.encoderId && this._teamPlayers(team.key).length > 1) {
      throw new GameError('加密者不参与本队的破译');
    }
    if (!isCode(code)) throw new GameError('密码必须是 1-4 中三个不重复的数字');
    team.guesses.decode = code.map(Number);
    team.submissions.decode = true;
    this._touch();
    this._advanceIfReady();
  }

  _advanceIfReady() {
    const both = (field) => this.teams.A.submissions[field] && this.teams.B.submissions[field];
    if (this.phase === PHASE.ENCRYPT && both('clues')) {
      this.phase = PHASE.INTERCEPT;
      this._touch();
    } else if (this.phase === PHASE.INTERCEPT && both('intercept')) {
      this.phase = PHASE.DECODE;
      this._touch();
    } else if (this.phase === PHASE.DECODE && both('decode')) {
      this._resolveRound();
    }
  }

  _resolveRound() {
    const reveal = { round: this.round, teams: {} };

    for (const key of TEAM_KEYS) {
      const team = this.teams[key];
      const opponent = this.teams[otherTeam(key)];
      const decoded = sameCode(team.guesses.decode, team.code);
      const intercepted = sameCode(opponent.guesses.intercept, team.code);

      if (intercepted) opponent.tokens.white += 1;
      if (!decoded) team.tokens.black += 1;

      team.code.forEach((number, index) => {
        team.archive[number - 1].push({
          round: this.round,
          clue: team.clues[index],
          author: team.clueAuthor || 'human',
        });
      });

      reveal.teams[key] = {
        code: [...team.code],
        clues: cloneClues(team.clues),
        decoded,
        intercepted,
        tokens: { ...team.tokens },
      };
    }

    this.lastReveal = reveal;
    this.phase = PHASE.REVEAL;
    this._maybeEnd();
    this._touch();
  }

  _score(key) {
    const tokens = this.teams[key].tokens;
    return tokens.white - tokens.black;
  }

  _maybeEnd() {
    const a = this.teams.A.tokens;
    const b = this.teams.B.tokens;
    const reached = a.white >= 2 || b.white >= 2 || a.black >= 2 || b.black >= 2;
    if (!reached && this.round < this.settings.maxRounds) return;
    this._finishByScore(reached ? '触发胜负标记' : '轮数用尽');
  }

  _finishByScore(reason) {
    const scoreA = this._score('A');
    const scoreB = this._score('B');
    this.status = 'ended';
    this.phase = PHASE.ENDED;
    this.winner = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'A' : 'B';
    this.endReason = reason;
    this._touch();
  }

  nextRound(playerId) {
    this._assertPhase(PHASE.REVEAL);
    const host = this.players.get(this.hostId);
    if (playerId !== this.hostId && host && host.connected) {
      throw new GameError('只有房主可以开始下一轮');
    }
    this.startRound();
  }

  restart(playerId) {
    if (playerId !== this.hostId) throw new GameError('只有房主可以重开');
    if (this.status !== 'ended') throw new GameError('对局还没有结束');

    this.status = 'lobby';
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.winner = null;
    this.endReason = '';
    this.lastReveal = null;
    for (const key of TEAM_KEYS) {
      const team = this.teams[key];
      team.keywords = [];
      team.encoderId = null;
      team.encoderCursor = 0;
      team.code = null;
      team.clues = null;
      team.clueAuthor = null;
      team.guesses = { intercept: null, decode: null };
      team.submissions = { clues: false, intercept: false, decode: false };
      team.tokens = { white: 0, black: 0 };
      team.archive = [[], [], [], []];
      team.aiRunning = false;
    }
    this._touch();
  }

  publicState(viewerId) {
    const me = this.players.get(viewerId) || null;
    const myTeamKey = me ? me.team : null;
    const revealPhase = this.phase === PHASE.REVEAL || this.phase === PHASE.ENDED;
    const cluesPublic = [
      PHASE.INTERCEPT,
      PHASE.DECODE,
      PHASE.REVEAL,
      PHASE.ENDED,
    ].includes(this.phase);

    const state = {
      roomId: this.id,
      status: this.status,
      phase: this.phase,
      round: this.round,
      maxRounds: this.settings.maxRounds,
      aiMode: this.settings.aiMode,
      hostId: this.hostId,
      pack: { id: this.pack.id, name: this.pack.name },
      you: me
        ? {
            id: me.id,
            name: me.name,
            team: me.team,
            isHost: me.id === this.hostId,
            isEncoder: this.teams[me.team].encoderId === me.id,
          }
        : null,
      teams: {},
      winner: this.winner,
      endReason: this.endReason,
      lastReveal: revealPhase ? this.lastReveal : null,
      createdAt: this.createdAt,
    };

    for (const key of TEAM_KEYS) {
      const team = this.teams[key];
      const isMine = key === myTeamKey;
      const players = team.players
        .map((id) => this.players.get(id))
        .filter(Boolean)
        .map((player) => ({
          id: player.id,
          name: player.name,
          connected: player.connected,
          isEncoder: player.id === team.encoderId,
        }));

      state.teams[key] = {
        key,
        players,
        tokens: { ...team.tokens },
        encoderId: team.encoderId,
        keywords: isMine || this.phase === PHASE.ENDED ? [...team.keywords] : null,
        archive: team.archive.map((column) =>
          column.map((entry) => ({
            round: entry.round,
            clue: entry.clue,
            author: entry.author,
          })),
        ),
        submissions: { ...team.submissions },
        clues:
          (isMine && this.phase === PHASE.ENCRYPT) || cluesPublic
            ? cloneClues(team.clues)
            : null,
        code:
          (isMine &&
            me &&
            team.encoderId === me.id &&
            this.phase === PHASE.ENCRYPT) ||
          revealPhase
            ? team.code
              ? [...team.code]
              : null
            : null,
        guesses:
          isMine || revealPhase
            ? {
                intercept: team.guesses.intercept ? [...team.guesses.intercept] : null,
                decode: team.guesses.decode ? [...team.guesses.decode] : null,
              }
            : { intercept: null, decode: null },
        aiRunning: Boolean(team.aiRunning),
      };
    }

    return state;
  }
}

/* ------------------------------------------------------------------ */
/* 关键词采样：优先整组抽取，避免同队重复                                */
/* ------------------------------------------------------------------ */

function sampleFourWords(pack, usedWords, usedSets) {
  const sets = Array.isArray(pack.sets) ? pack.sets : [];
  const words = Array.isArray(pack.words) ? pack.words : [];

  const availableSets = sets
    .map((set, index) => ({ set, index }))
    .filter(({ set, index }) => {
      if (usedSets.has(index)) return false;
      if (!Array.isArray(set) || set.length < 4) return false;
      return set.every((word) => !usedWords.has(word));
    });

  if (availableSets.length) {
    const picked = availableSets[Math.floor(Math.random() * availableSets.length)];
    usedSets.add(picked.index);
    const four = picked.set.slice(0, 4);
    four.forEach((word) => usedWords.add(word));
    return [...four];
  }

  const remaining = shuffle(words.filter((word) => !usedWords.has(word)));
  if (remaining.length >= 4) {
    const four = remaining.slice(0, 4);
    four.forEach((word) => usedWords.add(word));
    return four;
  }

  // 兜底：允许复用（题库刚好不够时至少能开局）
  const fallback = shuffle(words.length >= 4 ? words : sets.flat());
  if (fallback.length < 4) throw new GameError('题库不足，至少需要 8 个词或 2 组四词');
  return fallback.slice(0, 4);
}

module.exports = {
  GameRoom,
  GameError,
  PHASE,
  TEAM_KEYS,
  MAX_PLAYERS,
  MAX_CLUE_LEN,
  isCode,
  sameCode,
  randomCode,
  otherTeam,
  cleanName,
  sampleFourWords,
};
