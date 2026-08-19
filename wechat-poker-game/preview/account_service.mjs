import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(pbkdf2);
const ACCOUNT_RE = /^[a-z][a-z0-9_.-]{3,23}$/;
const MAX_PASSWORD_LENGTH = 64;
const PASSWORD_ITERATIONS = 210000;
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

export function createAccountService() {
  const accounts = new Map();
  const nicknames = new Map();

  async function register(input) {
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
      createdAt: now,
      updatedAt: now
    };
    accounts.set(username, account);
    return { auth: createSession(account), account: presentAccount(account) };
  }

  async function login(input) {
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
    return {
      auth: { username, token, expiresAt: session.expiresAt },
      account: presentAccount(account)
    };
  }

  function updateProfile(username, profileInput) {
    const account = accounts.get(username);
    if (!account) {
      throw new AccountServiceError("账号不存在，请重新登录。", 404, "account_not_found");
    }
    ensureProfileEditable(account);
    const profile = normalizeProfile(profileInput);
    claimNickname(username, profile.name);
    const previous = account.profile;
    account.profile = profile;
    account.updatedAt = Date.now();
    if (nicknameKey(previous.name) !== nicknameKey(profile.name)) {
      releaseNickname(username, previous.name);
    }
    return presentAccount(account);
  }

  function recordRound(username, recordInput) {
    const account = accounts.get(username);
    if (!account || !recordInput || !recordInput.id || account.records.has(recordInput.id)) {
      return;
    }
    const record = cloneRecord(recordInput);
    account.records.set(record.id, record);
    account.history = [makeHistorySummary(record, username), ...account.history]
      .sort((left, right) => Number(right.completedAt || 0) - Number(left.completedAt || 0));
    const removed = account.history.slice(MAX_HISTORY);
    account.history = account.history.slice(0, MAX_HISTORY);
    for (const item of removed) {
      account.records.delete(item.id);
    }
  }

  function lockProfileFromRoom(username, roomCode) {
    const account = accounts.get(username);
    if (!account) {
      throw new AccountServiceError("账号不存在，请重新登录。", 404, "account_not_found");
    }
    account.profileLock = {
      roomCode: String(roomCode || ""),
      expiresAt: Date.now() + PROFILE_LOCK_MS
    };
  }

  async function handle(req, res, url, transport) {
    const { pathname } = url;
    if (pathname === "/api/auth/register") {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const body = await transport.readJson(req);
      return transport.sendJson(res, await register(body), 201);
    }
    if (pathname === "/api/auth/login") {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const body = await transport.readJson(req);
      return transport.sendJson(res, await login(body));
    }

    const authenticated = authenticateRequest(req);
    if (pathname === "/api/auth/me") {
      if (req.method !== "GET") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      return transport.sendJson(res, { account: authenticated.account });
    }
    if (pathname === "/api/auth/logout") {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const account = accounts.get(authenticated.auth.username);
      account.sessions.delete(authenticated.auth.token);
      return transport.sendJson(res, { loggedOut: true });
    }
    if (pathname === "/api/account/profile") {
      if (req.method !== "POST") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const body = await transport.readJson(req);
      return transport.sendJson(res, { account: updateProfile(authenticated.auth.username, body.profile) });
    }
    if (pathname === "/api/account/history") {
      if (req.method !== "GET") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const account = accounts.get(authenticated.auth.username);
      return transport.sendJson(res, { records: account.history.slice() });
    }
    const replayMatch = pathname.match(/^\/api\/account\/history\/([a-zA-Z0-9_-]+)$/);
    if (replayMatch) {
      if (req.method !== "GET") {
        return transport.sendJson(res, { error: "method_not_allowed", message: "请求方法不支持。" }, 405);
      }
      const account = accounts.get(authenticated.auth.username);
      const record = account.records.get(replayMatch[1]);
      if (!record) {
        throw new AccountServiceError("该战绩已过期或不存在。", 404, "record_not_found");
      }
      return transport.sendJson(res, { record });
    }
    throw new AccountServiceError("接口不存在。", 404, "not_found");
  }

  return {
    handle,
    authenticateRequest,
    updateProfile,
    recordRound,
    lockProfileFromRoom
  };

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

  function ensureProfileEditable(account) {
    const lock = account.profileLock;
    if (!lock) {
      return;
    }
    if (Number(lock.expiresAt || 0) <= Date.now()) {
      delete account.profileLock;
      return;
    }
    throw new AccountServiceError("该账号正在已开局的房间中，暂时不能修改昵称或头像。", 409, "profile_locked");
  }
}

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

async function hashPassword(password, salt = randomBytes(16)) {
  const hash = await deriveKey(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

async function verifyPassword(password, stored) {
  if (!stored) {
    return false;
  }
  const candidate = await hashPassword(password, Buffer.from(stored.salt, "base64"));
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
  return JSON.parse(JSON.stringify(record));
}

function nicknameKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
