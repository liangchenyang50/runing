import { DurableObject } from "cloudflare:workers";

const ACCOUNT_RE = /^[a-z][a-z0-9_.-]{3,23}$/;
const MAX_PASSWORD_LENGTH = 64;
const PASSWORD_ITERATIONS = 100000;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_SESSIONS = 8;
const MAX_HISTORY = 5;
const PROFILE_LOCK_MS = 1000 * 60 * 60 * 24;
const MAX_NAME_LENGTH = 12;
const MAX_AVATAR_DATA_LENGTH = 320000;
const AVATAR_ASSET_RE = /^\/assets\/avatars\/portrait-[1-4]\.jpg$/;

export class PlayerAccount extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.account = null;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.account = await this.ctx.storage.get("account") || null;
    });
  }

  async register(input) {
    return this.asResult(async () => {
      const username = normalizeUsername(input && input.username);
      const password = validatePassword(input && input.password);
      if (this.account) {
        throw new AccountError("该账号已注册，请直接登录。", 409, "account_exists");
      }
      const now = Date.now();
      const profile = normalizeProfile({ name: username, avatar: "😀" });
      await this.claimNickname(profile.name, username);
      this.account = {
        username,
        password: await hashPassword(password),
        profile,
        createdAt: now,
        updatedAt: now
      };
      await this.ctx.storage.put("account", this.account);
      const auth = await this.createSession();
      return { auth, account: presentAccount(this.account) };
    });
  }

  async login(input) {
    return this.asResult(async () => {
      const password = String(input && input.password || "");
      const account = this.requireAccount();
      if (!await verifyPassword(password, account.password)) {
        throw new AccountError("账号或密码错误。", 401, "invalid_credentials");
      }
      const auth = await this.createSession();
      return { auth, account: presentAccount(account) };
    });
  }

  async authenticate(token) {
    return this.asResult(async () => {
      const account = this.requireAccount();
      const session = await this.requireSession(token);
      return {
        auth: {
          username: account.username,
          token: String(token),
          expiresAt: session.expiresAt
        },
        account: presentAccount(account)
      };
    });
  }

  async logout(token) {
    return this.asResult(async () => {
      await this.requireSession(token);
      await this.ctx.storage.delete(sessionKey(token));
      return { loggedOut: true };
    });
  }

  async updateProfile(token, profileInput) {
    return this.asResult(async () => {
      await this.requireSession(token);
      await this.ensureProfileEditable();
      return this.saveProfile(profileInput);
    });
  }

  async updateProfileFromRoom(profileInput) {
    return this.asResult(async () => {
      await this.ensureProfileEditable();
      return this.saveProfile(profileInput);
    });
  }

  async lockProfileFromRoom(roomCode) {
    return this.asResult(async () => {
      this.requireAccount();
      await this.ctx.storage.put("profile-lock", {
        roomCode: String(roomCode || ""),
        expiresAt: Date.now() + PROFILE_LOCK_MS
      });
      return { locked: true };
    });
  }

  async getHistory(token) {
    return this.asResult(async () => {
      await this.requireSession(token);
      const history = await this.ctx.storage.get("history") || [];
      return { records: history.slice(0, MAX_HISTORY) };
    });
  }

  async getReplay(token, recordId) {
    return this.asResult(async () => {
      await this.requireSession(token);
      const id = String(recordId || "").trim();
      if (!id) {
        throw new AccountError("请选择要复盘的对局。", 400, "invalid_record");
      }
      const record = await this.ctx.storage.get(recordKey(id));
      if (!record) {
        throw new AccountError("该战绩已过期或不存在。", 404, "record_not_found");
      }
      return { record };
    });
  }

  async recordRound(recordInput) {
    return this.asResult(async () => {
      const account = this.requireAccount();
      const record = cloneRecord(recordInput);
      if (!record || !record.id || !Array.isArray(record.players) || !Array.isArray(record.initialHands)) {
        throw new AccountError("复盘数据不完整。", 400, "invalid_record");
      }
      if (!record.players.some((player) => player.accountId === account.username)) {
        throw new AccountError("账号不属于这局对战。", 403, "record_owner_mismatch");
      }
      const recordId = String(record.id);
      const history = await this.ctx.storage.get("history") || [];
      if (history.some((item) => item.id === recordId)) {
        return { stored: false, recordId };
      }
      const serialized = JSON.stringify(record);
      if (serialized.length > 180000) {
        throw new AccountError("本局复盘数据过大，未能保存。", 413, "record_too_large");
      }
      const nextHistory = [makeHistorySummary(record, account.username), ...history]
        .sort((left, right) => Number(right.completedAt || 0) - Number(left.completedAt || 0));
      const removed = nextHistory.slice(MAX_HISTORY);
      const kept = nextHistory.slice(0, MAX_HISTORY);
      await this.ctx.storage.put(recordKey(recordId), record);
      await this.ctx.storage.put("history", kept);
      await Promise.all(removed.map((item) => this.ctx.storage.delete(recordKey(item.id))));
      return { stored: true, recordId };
    });
  }

  async asResult(callback) {
    try {
      await this.ready;
      return { ok: true, data: await callback() };
    } catch (error) {
      return { ok: false, error: errorDetails(error) };
    }
  }

  requireAccount() {
    if (!this.account) {
      throw new AccountError("账号不存在，请先注册。", 404, "account_not_found");
    }
    return this.account;
  }

  async requireSession(token) {
    const value = String(token || "").trim();
    if (!value) {
      throw new AccountError("请先登录。", 401, "auth_required");
    }
    const session = await this.ctx.storage.get(sessionKey(value));
    if (!session || Number(session.expiresAt || 0) <= Date.now()) {
      await this.ctx.storage.delete(sessionKey(value));
      throw new AccountError("登录已过期，请重新登录。", 401, "session_expired");
    }
    return session;
  }

  async createSession() {
    const token = createToken();
    const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
    const sessions = await this.ctx.storage.list({ prefix: "session:" });
    const stale = [];
    for (const [key, value] of sessions) {
      if (Number(value && value.expiresAt || 0) <= Date.now()) {
        stale.push(key);
      }
    }
    const active = Array.from(sessions.entries())
      .filter(([key]) => !stale.includes(key))
      .sort((left, right) => Number(left[1] && left[1].createdAt || 0) - Number(right[1] && right[1].createdAt || 0));
    const overflow = Math.max(0, active.length - MAX_SESSIONS + 1);
    const removed = active.slice(0, overflow).map(([key]) => key);
    await Promise.all([...stale, ...removed].map((key) => this.ctx.storage.delete(key)));
    await this.ctx.storage.put(sessionKey(token), { createdAt: Date.now(), expiresAt });
    return { username: this.requireAccount().username, token, expiresAt };
  }

  async saveProfile(profileInput) {
    const account = this.requireAccount();
    const previousProfile = account.profile || { name: account.username, avatar: "😀" };
    const profile = normalizeProfile(profileInput);
    await this.claimNickname(profile.name);
    account.profile = profile;
    account.updatedAt = Date.now();
    await this.ctx.storage.put("account", account);
    if (nicknameKey(previousProfile.name) !== nicknameKey(profile.name)) {
      await this.releaseNickname(previousProfile.name);
    }
    return { account: presentAccount(account) };
  }

  async ensureProfileEditable() {
    const lock = await this.ctx.storage.get("profile-lock");
    if (!lock) {
      return;
    }
    if (Number(lock.expiresAt || 0) <= Date.now()) {
      await this.ctx.storage.delete("profile-lock");
      return;
    }
    throw new AccountError("该账号正在已开局的房间中，暂时不能修改昵称或头像。", 409, "profile_locked");
  }

  async claimNickname(name, owner = this.requireAccountName()) {
    const result = await this.env.NICKNAME_CLAIM
      .getByName(`nickname:${nicknameKey(name)}`)
      .claim(owner);
    if (!result.ok) {
      throw new AccountError(result.error.message || "该昵称已被使用。", result.error.status || 409, result.error.code || "nickname_taken");
    }
  }

  async releaseNickname(name) {
    await this.env.NICKNAME_CLAIM
      .getByName(`nickname:${nicknameKey(name)}`)
      .release(this.requireAccountName());
  }

  requireAccountName() {
    return this.account ? this.account.username : "";
  }
}

export class NicknameClaim extends DurableObject {
  async claim(username) {
    const owner = await this.ctx.storage.get("owner");
    if (owner && owner !== username) {
      return { ok: false, error: { code: "nickname_taken", message: "该昵称已被其他账号使用，请换一个。", status: 409 } };
    }
    await this.ctx.storage.put("owner", String(username || ""));
    return { ok: true, data: { owner: String(username || "") } };
  }

  async release(username) {
    const owner = await this.ctx.storage.get("owner");
    if (owner === username) {
      await this.ctx.storage.delete("owner");
    }
    return { ok: true, data: { released: owner === username } };
  }
}

export function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!ACCOUNT_RE.test(username)) {
    throw new AccountError("账号需为 4-24 位，以字母开头，只能使用字母、数字、点、下划线或短横线。", 400, "invalid_username");
  }
  return username;
}

export function normalizeProfile(source) {
  const input = source && typeof source === "object" ? source : {};
  const name = Array.from(String(input.name || "").trim().replace(/\s+/g, " ") || "玩家")
    .slice(0, MAX_NAME_LENGTH)
    .join("");
  return {
    name,
    avatar: sanitizeAvatar(input.avatar)
  };
}

export function sanitizeAvatar(value) {
  if (typeof value !== "string") {
    return "😀";
  }
  const avatar = value.trim();
  if (!avatar) {
    return "😀";
  }
  if (AVATAR_ASSET_RE.test(avatar)) {
    return avatar;
  }
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(avatar)) {
    return avatar.length <= MAX_AVATAR_DATA_LENGTH ? avatar : "😀";
  }
  return Array.from(avatar).slice(0, 4).join("") || "😀";
}

export class AccountError extends Error {
  constructor(message, status = 400, code = "account_error") {
    super(message);
    this.name = "AccountError";
    this.status = status;
    this.code = code;
  }
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > MAX_PASSWORD_LENGTH || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new AccountError("密码需为 8-64 位，且同时包含字母和数字。", 400, "weak_password");
  }
  return password;
}

async function hashPassword(password, salt = randomBytes(16), iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations
  }, key, 256);
  return {
    algorithm: "PBKDF2-SHA-256",
    iterations,
    salt: encodeBase64(salt),
    hash: encodeBase64(new Uint8Array(bits))
  };
}

async function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== "PBKDF2-SHA-256") {
    return false;
  }
  const salt = decodeBase64(stored.salt);
  const expected = decodeBase64(stored.hash);
  const iterations = Number(stored.iterations || PASSWORD_ITERATIONS);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_ITERATIONS) {
    return false;
  }
  const candidate = await hashPassword(password, salt, iterations);
  const actual = decodeBase64(candidate.hash);
  if (actual.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) {
    mismatch |= actual[index] ^ expected[index];
  }
  return mismatch === 0;
}

function presentAccount(account) {
  return {
    username: account.username,
    profile: { ...account.profile },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function makeHistorySummary(record, username) {
  const me = record.players.find((player) => player.accountId === username) || {};
  const winner = record.players.find((player) => player.seat === record.winnerId) || {};
  const myScore = (record.scores || []).find((score) => score.playerId === me.seat);
  return {
    id: record.id,
    roomCode: record.roomCode,
    roundNumber: record.roundNumber,
    targetScore: record.targetScore,
    completedAt: record.completedAt,
    playerNames: record.players.map((player) => player.name),
    winnerName: winner.name || "未定",
    eventCount: Array.isArray(record.events) ? record.events.length : 0,
    myScore: myScore ? myScore.score : null,
    isWinner: me.seat === record.winnerId
  };
}

function cloneRecord(record) {
  try {
    return JSON.parse(JSON.stringify(record));
  } catch {
    throw new AccountError("复盘数据格式不正确。", 400, "invalid_record");
  }
}

function sessionKey(token) {
  return `session:${token}`;
}

function recordKey(id) {
  return `record:${id}`;
}

function nicknameKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function createToken() {
  const bytes = randomBytes(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function errorDetails(error) {
  if (error instanceof AccountError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: "account_error", message: error instanceof Error ? error.message : "账号服务暂时不可用。", status: 500 };
}
