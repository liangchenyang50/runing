import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(pbkdf2);
const ACCOUNT_RE = /^[a-z][a-z0-9_.-]{3,23}$/;
const MAX_PASSWORD_LENGTH = 64;
const PASSWORD_ITERATIONS = 100000;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_HISTORY = 5;
const PROFILE_LOCK_MS = 1000 * 60 * 60 * 24;
const MAX_NAME_LENGTH = 12;
const MAX_AVATAR_DATA_LENGTH = 320000;
const AVATAR_ASSET_RE = /^\/assets\/avatars\/portrait-[1-4]\.jpg$/;

export class AccountServiceError extends Error {
  constructor(message, status = 400, code = "account_error") {
    super(message);
    this.name = "AccountServiceError";
    this.status = status;
    this.code = code;
  }
}

export function createMysqlAccountService(pool) {
  const accounts = new Map();
  const nicknames = new Map();
  const pendingWrites = new Set();
  const ready = loadAccounts();

  async function loadAccounts() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username VARCHAR(24) NOT NULL PRIMARY KEY,
        password_salt VARCHAR(64) NOT NULL,
        password_hash VARCHAR(64) NOT NULL,
        password_iterations INT NOT NULL,
        profile_name VARCHAR(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
        profile_avatar MEDIUMTEXT NOT NULL,
        profile_lock_room VARCHAR(6) NULL,
        profile_lock_expires_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_records (
        account_username VARCHAR(24) NOT NULL,
        record_id VARCHAR(64) NOT NULL,
        completed_at BIGINT NOT NULL,
        summary JSON NOT NULL,
        record JSON NOT NULL,
        PRIMARY KEY (account_username, record_id),
        CONSTRAINT match_records_account_fk FOREIGN KEY (account_username)
          REFERENCES accounts(username) ON DELETE CASCADE,
        KEY match_records_recent (account_username, completed_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const [rows] = await pool.query("SELECT * FROM accounts");
    for (const row of rows) {
      const account = {
        username: row.username,
        password: { salt: row.password_salt, hash: row.password_hash, iterations: row.password_iterations },
        profile: { name: row.profile_name, avatar: row.profile_avatar },
        history: [],
        records: new Map(),
        sessions: new Map(),
        profileLock: row.profile_lock_expires_at ? {
          roomCode: row.profile_lock_room || "",
          expiresAt: Number(row.profile_lock_expires_at)
        } : null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at)
      };
      accounts.set(account.username, account);
      nicknames.set(nicknameKey(account.profile.name), account.username);
    }
    const [records] = await pool.query("SELECT * FROM match_records ORDER BY completed_at DESC");
    for (const row of records) {
      const account = accounts.get(row.account_username);
      if (!account || account.history.length >= MAX_HISTORY) {
        continue;
      }
      const record = parseJson(row.record);
      const summary = parseJson(row.summary);
      if (!record || !summary) {
        continue;
      }
      account.records.set(row.record_id, record);
      account.history.push(summary);
    }
  }

  async function register(input) {
    await ready;
    const username = normalizeUsername(input && input.username);
    const password = validatePassword(input && input.password);
    if (accounts.has(username)) {
      throw new AccountServiceError("该账号已注册，请直接登录。", 409, "account_exists");
    }
    const profile = normalizeProfile({ name: username, avatar: "😀" });
    claimNickname(username, profile.name);
    const now = Date.now();
    const account = {
      username,
      password: await hashPassword(password),
      profile,
      history: [],
      records: new Map(),
      sessions: new Map(),
      profileLock: null,
      createdAt: now,
      updatedAt: now
    };
    try {
      await pool.execute(
        `INSERT INTO accounts (username, password_salt, password_hash, password_iterations, profile_name, profile_avatar, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, account.password.salt, account.password.hash, account.password.iterations, profile.name, profile.avatar, now, now]
      );
    } catch (error) {
      nicknames.delete(nicknameKey(profile.name));
      if (error && error.code === "ER_DUP_ENTRY") {
        throw new AccountServiceError("该账号或昵称已被使用。", 409, "account_exists");
      }
      throw error;
    }
    accounts.set(username, account);
    return { auth: createSession(account), account: presentAccount(account) };
  }

  async function login(input) {
    await ready;
    const username = normalizeUsername(input && input.username);
    const account = accounts.get(username);
    if (!account || !await verifyPassword(String(input && input.password || ""), account.password)) {
      throw new AccountServiceError("账号或密码错误。", 401, "invalid_credentials");
    }
    return { auth: createSession(account), account: presentAccount(account) };
  }

  function authenticateRequest(req) {
    const authorization = String(req.headers && req.headers.authorization || "");
    const match = authorization.match(/^Bearer\s+([^:\s]+):([^\s]+)$/i);
    if (!match) {
      throw new AccountServiceError("请先登录账号。", 401, "auth_required");
    }
    const username = normalizeUsername(match[1]);
    const account = accounts.get(username);
    const token = match[2];
    const session = account && account.sessions.get(token);
    if (!account || !session || session.expiresAt <= Date.now()) {
      if (account) {
        account.sessions.delete(token);
      }
      throw new AccountServiceError("登录已过期，请重新登录。", 401, "session_expired");
    }
    return { auth: { username, token, expiresAt: session.expiresAt }, account: presentAccount(account) };
  }

  function updateProfile(username, profileInput) {
    const account = accounts.get(username);
    if (!account) {
      throw new AccountServiceError("账号不存在，请重新登录。", 404, "account_not_found");
    }
    ensureProfileEditable(account);
    const profile = normalizeProfile(profileInput);
    claimNickname(username, profile.name);
    const previousName = account.profile.name;
    account.profile = profile;
    account.updatedAt = Date.now();
    if (nicknameKey(previousName) !== nicknameKey(profile.name)) {
      releaseNickname(username, previousName);
    }
    queueWrite(pool.execute(
      "UPDATE accounts SET profile_name = ?, profile_avatar = ?, updated_at = ? WHERE username = ?",
      [profile.name, profile.avatar, account.updatedAt, username]
    ));
    return presentAccount(account);
  }

  function recordRound(username, recordInput) {
    const account = accounts.get(username);
    if (!account || !recordInput || !recordInput.id || account.records.has(recordInput.id)) {
      return;
    }
    const record = cloneRecord(recordInput);
    const summary = makeHistorySummary(record, username);
    account.records.set(record.id, record);
    account.history = [summary, ...account.history]
      .sort((left, right) => Number(right.completedAt || 0) - Number(left.completedAt || 0));
    const removed = account.history.slice(MAX_HISTORY);
    account.history = account.history.slice(0, MAX_HISTORY);
    for (const item of removed) {
      account.records.delete(item.id);
    }
    queueWrite((async () => {
      await pool.execute(
        `INSERT INTO match_records (account_username, record_id, completed_at, summary, record)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at), summary = VALUES(summary), record = VALUES(record)`,
        [username, record.id, Number(record.completedAt || Date.now()), JSON.stringify(summary), JSON.stringify(record)]
      );
      await pool.execute(
        `DELETE FROM match_records
         WHERE account_username = ? AND record_id NOT IN (
           SELECT record_id FROM (
             SELECT record_id FROM match_records WHERE account_username = ? ORDER BY completed_at DESC LIMIT ${MAX_HISTORY}
           ) AS recent_records
         )`,
        [username, username]
      );
    })());
  }

  function lockProfileFromRoom(username, roomCode) {
    const account = accounts.get(username);
    if (!account) {
      throw new AccountServiceError("账号不存在，请重新登录。", 404, "account_not_found");
    }
    account.profileLock = { roomCode: String(roomCode || ""), expiresAt: Date.now() + PROFILE_LOCK_MS };
    queueWrite(pool.execute(
      "UPDATE accounts SET profile_lock_room = ?, profile_lock_expires_at = ? WHERE username = ?",
      [account.profileLock.roomCode, account.profileLock.expiresAt, username]
    ));
  }

  async function handle(req, res, url, transport) {
    await ready;
    const { pathname } = url;
    if (pathname === "/api/auth/register") {
      if (req.method !== "POST") return transport.sendJson(res, methodError(), 405);
      return transport.sendJson(res, await register(await transport.readJson(req)), 201);
    }
    if (pathname === "/api/auth/login") {
      if (req.method !== "POST") return transport.sendJson(res, methodError(), 405);
      return transport.sendJson(res, await login(await transport.readJson(req)));
    }
    const authenticated = authenticateRequest(req);
    if (pathname === "/api/auth/me") {
      if (req.method !== "GET") return transport.sendJson(res, methodError(), 405);
      return transport.sendJson(res, { account: authenticated.account });
    }
    if (pathname === "/api/auth/logout") {
      if (req.method !== "POST") return transport.sendJson(res, methodError(), 405);
      accounts.get(authenticated.auth.username).sessions.delete(authenticated.auth.token);
      return transport.sendJson(res, { loggedOut: true });
    }
    if (pathname === "/api/account/profile") {
      if (req.method !== "POST") return transport.sendJson(res, methodError(), 405);
      const body = await transport.readJson(req);
      return transport.sendJson(res, { account: updateProfile(authenticated.auth.username, body.profile) });
    }
    if (pathname === "/api/account/history") {
      if (req.method !== "GET") return transport.sendJson(res, methodError(), 405);
      return transport.sendJson(res, { records: accounts.get(authenticated.auth.username).history.slice() });
    }
    const replayMatch = pathname.match(/^\/api\/account\/history\/([a-zA-Z0-9_-]+)$/);
    if (replayMatch) {
      if (req.method !== "GET") return transport.sendJson(res, methodError(), 405);
      const record = accounts.get(authenticated.auth.username).records.get(replayMatch[1]);
      if (!record) throw new AccountServiceError("该战绩已过期或不存在。", 404, "record_not_found");
      return transport.sendJson(res, { record });
    }
    throw new AccountServiceError("接口不存在。", 404, "not_found");
  }

  function claimNickname(username, name) {
    const key = nicknameKey(name);
    const owner = nicknames.get(key);
    if (owner && owner !== username) {
      throw new AccountServiceError("该昵称已被其他账号使用，请换一个。", 409, "nickname_taken");
    }
    nicknames.set(key, username);
  }

  function releaseNickname(username, name) {
    const key = nicknameKey(name);
    if (nicknames.get(key) === username) {
      nicknames.delete(key);
    }
  }

  function queueWrite(promise) {
    pendingWrites.add(promise);
    promise.catch((error) => console.error("database_write_failed", error)).finally(() => pendingWrites.delete(promise));
  }

  return { ready, handle, authenticateRequest, updateProfile, recordRound, lockProfileFromRoom, flush: () => Promise.allSettled([...pendingWrites]) };
}

function methodError() { return { error: "method_not_allowed", message: "请求方法不支持。" }; }

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!ACCOUNT_RE.test(username)) {
    throw new AccountServiceError("账号需为 4-24 位，以字母开头，只能使用字母、数字、点、下划线或短横线。", 400, "invalid_username");
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > MAX_PASSWORD_LENGTH || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new AccountServiceError("密码需为 8-64 位，且同时包含字母和数字。", 400, "weak_password");
  }
  return password;
}

function normalizeProfile(source) {
  const input = source && typeof source === "object" ? source : {};
  const name = Array.from(String(input.name || "").trim().replace(/\s+/g, " ") || "玩家")
    .slice(0, MAX_NAME_LENGTH)
    .join("");
  return { name, avatar: sanitizeAvatar(input.avatar) };
}

function sanitizeAvatar(value) {
  const avatar = typeof value === "string" ? value.trim() : "";
  if (!avatar) return "😀";
  if (AVATAR_ASSET_RE.test(avatar)) return avatar;
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(avatar)) {
    return avatar.length <= MAX_AVATAR_DATA_LENGTH ? avatar : "😀";
  }
  return Array.from(avatar).slice(0, 4).join("") || "😀";
}

async function hashPassword(password, salt = randomBytes(16), iterations = PASSWORD_ITERATIONS) {
  const hash = await deriveKey(password, salt, iterations, 32, "sha256");
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), iterations };
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const iterations = Number(stored.iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_ITERATIONS) return false;
  const candidate = await hashPassword(password, Buffer.from(stored.salt, "base64"), iterations);
  const expected = Buffer.from(stored.hash, "base64");
  const actual = Buffer.from(candidate.hash, "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createSession(account) {
  const now = Date.now();
  const token = randomBytes(32).toString("hex");
  account.sessions.set(token, { createdAt: now, expiresAt: now + SESSION_MAX_AGE_MS });
  const active = Array.from(account.sessions.entries())
    .filter(([, session]) => session.expiresAt > now)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  for (const [oldToken] of active.slice(0, Math.max(0, active.length - 8))) {
    account.sessions.delete(oldToken);
  }
  return { username: account.username, token, expiresAt: now + SESSION_MAX_AGE_MS };
}

function presentAccount(account) {
  return {
    username: account.username,
    profile: { ...account.profile },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function ensureProfileEditable(account) {
  const lock = account.profileLock;
  if (!lock) return;
  if (Number(lock.expiresAt || 0) <= Date.now()) {
    delete account.profileLock;
    return;
  }
  throw new AccountServiceError("该账号正在已开局的房间中，暂时不能修改昵称或头像。", 409, "profile_locked");
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

function cloneRecord(record) { return JSON.parse(JSON.stringify(record)); }
function parseJson(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}
function nicknameKey(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
