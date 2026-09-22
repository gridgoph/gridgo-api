import { identityHasMembership } from "./authorization-context.js";
import { tooManyRequests } from "./support-rate-limit.js";

const CHAT_LOCK = "gridgo-support-chat";
const PARTY_ROLES = new Set(["client", "supplier", "rider"]);
const STAFF_ROLES = new Set(["ops_admin", "super_admin"]);
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_MAX = 4000;
const PREVIEW_MAX = 140;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 200;
const POST_LIMIT = 30;
const POST_WINDOW_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = Number(process.env.NOTIFICATION_HEARTBEAT_MS || 25_000);
const STREAM_MAX_MS = Number(process.env.NOTIFICATION_STREAM_MAX_MS || 10 * 60_000);

const listeners = new Set();

export function subscribeSupportChat(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSupportChat(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken SSE subscriber must not fail the write that already committed.
    }
  }
}

function emitChatEvent(database, event) {
  if (database.inWriteTransaction?.()) {
    database.afterCommit(() => publishSupportChat(event));
    return;
  }
  publishSupportChat(event);
}

export function isSupportChatRoute(pathname) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return path === "/support-chat" || path.startsWith("/support-chat/");
}

function asIso(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function parseMessageBody(value) {
  if (value == null || typeof value !== "string") {
    return { ok: false, message: "body must be a string." };
  }
  const body = value.replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, message: "Write a message." };
  if (body.length > MESSAGE_MAX) {
    return { ok: false, message: `Messages can be up to ${MESSAGE_MAX} characters.` };
  }
  return { ok: true, body };
}

export function messagePreview(body) {
  const compact = String(body || "").replace(/\s+/g, " ").trim();
  if (compact.length <= PREVIEW_MAX) return compact;
  return `${compact.slice(0, PREVIEW_MAX - 1)}…`;
}

export function actorRole(user) {
  return user?.role || null;
}

export function isPartyActor(user) {
  const role = actorRole(user);
  return Boolean(user && PARTY_ROLES.has(role) && identityHasMembership(user, role));
}

export function isStaffActor(user) {
  return Boolean(
    user && (identityHasMembership(user, "ops_admin") || identityHasMembership(user, "super_admin")),
  );
}

export function canViewThread(user, thread) {
  if (!user || !thread) return false;
  if (isStaffActor(user)) return true;
  return isPartyActor(user)
    && thread.partyUserId === user.id
    && thread.partyRole === actorRole(user);
}

function integerLimit(value, fallback = DEFAULT_MESSAGE_LIMIT) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MESSAGE_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function likePattern(value) {
  return `%${String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function mapThread(row, viewerId) {
  return {
    id: row.id,
    partyUserId: row.party_user_id,
    partyRole: row.party_role,
    partyName: row.party_name ?? null,
    partyEmail: row.party_email ?? null,
    lastMessageAt: row.last_message_at ? asIso(row.last_message_at) : null,
    lastMessagePreview: row.last_message_preview ?? null,
    lastMessageSenderRole: row.last_message_sender_role ?? null,
    unreadCount: Number(row.unread_count || 0),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    viewerUserId: viewerId,
  };
}

function mapMessage(row, viewerId) {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id,
    senderRole: row.sender_role,
    senderName: row.sender_name ?? null,
    body: row.body,
    createdAt: asIso(row.created_at),
    mine: row.sender_user_id === viewerId,
  };
}

export function formatChatEvent(event) {
  return `id: ${event.message.id}\nevent: support_chat\ndata: ${JSON.stringify(event)}\n\n`;
}

function threadSelect(viewerId) {
  return `
    SELECT
      t.id, t.party_user_id, t.party_role, t.last_message_at, t.last_message_preview,
      t.last_message_sender_role, t.created_at, t.updated_at,
      u.name AS party_name, u.email AS party_email,
      (
        SELECT count(*)::int
        FROM support_chat_messages m
        LEFT JOIN support_chat_reads r
          ON r.thread_id = t.id AND r.user_id = $1
        WHERE m.thread_id = t.id
          AND m.sender_user_id <> $1
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
      ) AS unread_count
    FROM support_chat_threads t
    JOIN users u ON u.id = t.party_user_id
  `;
}

export async function findThread(database, id, viewerId) {
  if (!THREAD_ID.test(String(id || ""))) return null;
  const result = await database.query(
    `${threadSelect(viewerId)} WHERE t.id = $2`,
    [viewerId, id],
  );
  const row = result.rows[0];
  return row ? mapThread(row, viewerId) : null;
}

export async function findPartyThread(database, userId, role, viewerId) {
  const result = await database.query(
    `${threadSelect(viewerId)}
     WHERE t.party_user_id = $2 AND t.party_role = $3
     ORDER BY t.last_message_at DESC NULLS LAST, t.updated_at DESC
     LIMIT 1`,
    [viewerId, userId, role],
  );
  const row = result.rows[0];
  return row ? mapThread(row, viewerId) : null;
}

export async function findDraftPartyThread(database, userId, role, viewerId) {
  const result = await database.query(
    `${threadSelect(viewerId)}
     WHERE t.party_user_id = $2 AND t.party_role = $3 AND t.last_message_at IS NULL
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [viewerId, userId, role],
  );
  const row = result.rows[0];
  return row ? mapThread(row, viewerId) : null;
}

export async function listPartyThreads(database, userId, role, viewerId, { includeDrafts = false } = {}) {
  const draftClause = includeDrafts ? "" : "AND t.last_message_at IS NOT NULL";
  const result = await database.query(
    `${threadSelect(viewerId)}
     WHERE t.party_user_id = $2 AND t.party_role = $3
       ${draftClause}
     ORDER BY t.last_message_at DESC NULLS LAST, t.updated_at DESC`,
    [viewerId, userId, role],
  );
  return result.rows.map((row) => mapThread(row, viewerId));
}

export async function listThreads(database, viewerId, { role, q, limit } = {}) {
  const values = [viewerId];
  const clauses = ["t.last_message_at IS NOT NULL"];
  if (role && PARTY_ROLES.has(role)) {
    values.push(role);
    clauses.push(`t.party_role = $${values.length}`);
  }
  if (q && String(q).trim()) {
    values.push(likePattern(String(q).trim()));
    clauses.push(
      `(u.name ILIKE $${values.length} ESCAPE '\\' OR u.email ILIKE $${values.length} ESCAPE '\\' OR coalesce(t.last_message_preview, '') ILIKE $${values.length} ESCAPE '\\')`,
    );
  }
  values.push(integerLimit(limit, 100));
  const result = await database.query(
    `${threadSelect(viewerId)}
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.last_message_at DESC, t.updated_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapThread(row, viewerId));
}

export async function listMessages(database, threadId, viewerId, { after, limit } = {}) {
  const values = [threadId];
  let afterClause = "";
  if (after && THREAD_ID.test(String(after))) {
    values.push(after);
    afterClause = `AND (m.created_at, m.id) > (
      SELECT created_at, id FROM support_chat_messages WHERE id = $${values.length}
    )`;
  }
  values.push(integerLimit(limit));
  const result = await database.query(
    `SELECT m.id, m.thread_id, m.sender_user_id, m.sender_role, m.body, m.created_at,
            u.name AS sender_name
     FROM support_chat_messages m
     JOIN users u ON u.id = m.sender_user_id
     WHERE m.thread_id = $1
       ${afterClause}
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapMessage(row, viewerId));
}

export async function markThreadRead(database, threadId, userId) {
  const latest = await database.query(
    `SELECT id FROM support_chat_messages
     WHERE thread_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [threadId],
  );
  const lastId = latest.rows[0]?.id ?? null;
  await database.query(
    `INSERT INTO support_chat_reads (thread_id, user_id, last_read_at, last_read_message_id)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (thread_id, user_id)
     DO UPDATE SET last_read_at = now(), last_read_message_id = EXCLUDED.last_read_message_id`,
    [threadId, userId, lastId],
  );
}

async function insertPartyThread(database, userId, role) {
  const result = await database.query(
    `INSERT INTO support_chat_threads (party_user_id, party_role)
     VALUES ($1, $2)
     RETURNING id`,
    [userId, role],
  );
  return result.rows[0].id;
}

export async function openPartyDraft(database, userId, role, viewerId) {
  const existing = await findDraftPartyThread(database, userId, role, viewerId);
  if (existing) return existing;
  const id = await insertPartyThread(database, userId, role);
  return findThread(database, id, viewerId);
}

async function resolvePartyThreadId(database, {
  threadId,
  createParty,
  newThread,
  viewerId,
}) {
  if (threadId) return threadId;
  if (!createParty) return null;
  const { userId, role } = createParty;
  if (newThread) {
    const draft = await openPartyDraft(database, userId, role, viewerId || userId);
    return draft?.id ?? null;
  }
  const latest = await findPartyThread(database, userId, role, viewerId || userId);
  if (latest) return latest.id;
  return insertPartyThread(database, userId, role);
}

export async function postMessage(database, {
  threadId,
  senderUserId,
  senderRole,
  body,
  createParty,
  newThread,
}) {
  const id = await resolvePartyThreadId(database, {
    threadId,
    createParty,
    newThread,
    viewerId: senderUserId,
  });
  if (!id) return null;
  const inserted = await database.query(
    `INSERT INTO support_chat_messages (thread_id, sender_user_id, sender_role, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, thread_id, sender_user_id, sender_role, body, created_at`,
    [id, senderUserId, senderRole, body],
  );
  const messageRow = inserted.rows[0];
  await database.query(
    `UPDATE support_chat_threads
     SET last_message_at = $2,
         last_message_preview = $3,
         last_message_sender_role = $4,
         updated_at = $2
     WHERE id = $1`,
    [id, messageRow.created_at, messagePreview(body), senderRole],
  );
  await markThreadRead(database, id, senderUserId);
  const sender = await database.query("SELECT name FROM users WHERE id = $1", [senderUserId]);
  const thread = await findThread(database, id, senderUserId);
  const message = mapMessage({ ...messageRow, sender_name: sender.rows[0]?.name ?? null }, senderUserId);
  return { thread, message };
}

function forbidden(send, res, message = "This conversation is not available on this account.") {
  send(res, 403, { error: "forbidden", message });
}

function unauthorized(send, res) {
  send(res, 401, {
    error: "unauthorized",
    message: "Sign in to GRIDGO, then retry this request with the new access token.",
  });
}

function invalid(send, res, message) {
  send(res, 400, { error: "invalid_request", message });
}

function notFound(send, res) {
  send(res, 404, {
    error: "support_chat_thread_not_found",
    message: "That conversation is not on this desk.",
  });
}

function rateLimited(send, res) {
  send(res, 429, {
    error: "too_many_requests",
    message: "You are sending messages too fast. Wait a moment and try again.",
  });
}

async function partySnapshot(database, user, { markRead = false } = {}) {
  const role = actorRole(user);
  const threads = await listPartyThreads(database, user.id, role, user.id);
  const unreadCount = threads.reduce((sum, row) => sum + Number(row.unreadCount || 0), 0);
  const thread = threads[0] ?? await findDraftPartyThread(database, user.id, role, user.id);
  if (!thread) return { threads, thread: null, messages: [], unreadCount };
  if (markRead) await markThreadRead(database, thread.id, user.id);
  const fresh = markRead ? await findThread(database, thread.id, user.id) : thread;
  const messages = await listMessages(database, thread.id, user.id, {});
  return { threads, thread: fresh, messages, unreadCount };
}

function openChatStream(req, res, { user, database, lastEventId }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(res.gridgoCorsHeaders || {}),
  });
  res.flushHeaders?.();
  res.write("retry: 5000\n\n");

  let closed = false;
  const writeEvent = (event) => {
    if (closed || !event?.thread || !event?.message) return;
    if (!canViewThread(user, event.thread)) return;
    // Unread is per viewer. The publisher has the sender's count, so refetch.
    void findThread(database, event.thread.id, user.id)
      .then((thread) => {
        if (closed || !thread || !canViewThread(user, thread)) return;
        res.write(formatChatEvent({
          type: "message",
          thread,
          message: { ...event.message, mine: event.message.senderUserId === user.id },
        }));
      })
      .catch(() => {});
  };

  const unsubscribe = subscribeSupportChat(writeEvent);
  const openedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - openedAt >= STREAM_MAX_MS) {
      res.end();
      return;
    }
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.once("aborted", cleanup);
  res.once("close", cleanup);

  void replayMissed(database, user, lastEventId, writeEvent);
  return true;
}

async function replayMissed(database, user, lastEventId, writeEvent) {
  if (!lastEventId || !THREAD_ID.test(String(lastEventId))) return;
  const anchor = await database.query(
    `SELECT id, thread_id, created_at FROM support_chat_messages WHERE id = $1`,
    [lastEventId],
  );
  if (!anchor.rows[0]) return;
  const values = [anchor.rows[0].created_at, lastEventId];
  let scope = "";
  if (isPartyActor(user)) {
    values.push(user.id, actorRole(user));
    scope = `AND t.party_user_id = $${values.length - 1} AND t.party_role = $${values.length}`;
  } else if (!isStaffActor(user)) {
    return;
  }
  const result = await database.query(
    `SELECT
        t.id AS thread_id, t.party_user_id, t.party_role, t.last_message_at,
        t.last_message_preview, t.last_message_sender_role, t.created_at AS thread_created_at,
        t.updated_at, u.name AS party_name, u.email AS party_email,
        m.id, m.sender_user_id, m.sender_role, m.body, m.created_at, s.name AS sender_name
     FROM support_chat_messages m
     JOIN support_chat_threads t ON t.id = m.thread_id
     JOIN users u ON u.id = t.party_user_id
     JOIN users s ON s.id = m.sender_user_id
     WHERE (m.created_at, m.id) > ($1, $2)
       ${scope}
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT 200`,
    values,
  );
  for (const row of result.rows) {
    writeEvent({
      type: "message",
      thread: mapThread({
        id: row.thread_id,
        party_user_id: row.party_user_id,
        party_role: row.party_role,
        last_message_at: row.last_message_at,
        last_message_preview: row.last_message_preview,
        last_message_sender_role: row.last_message_sender_role,
        created_at: row.thread_created_at,
        updated_at: row.updated_at,
        party_name: row.party_name,
        party_email: row.party_email,
        unread_count: 0,
      }, user.id),
      message: mapMessage(row, user.id),
    });
  }
}

export async function routeSupportChat({
  req,
  res,
  pathname,
  url,
  user,
  readBody,
  send,
  database,
}) {
  if (!isSupportChatRoute(pathname)) return false;
  if (!user) {
    unauthorized(send, res);
    return true;
  }

  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  const method = req.method;
  const threadMatch = /^\/support-chat\/threads\/([^/]+)$/.exec(path);
  const threadMessagesMatch = /^\/support-chat\/threads\/([^/]+)\/messages$/.exec(path);
  const threadReadMatch = /^\/support-chat\/threads\/([^/]+)\/read$/.exec(path);

  if (method === "GET" && path === "/support-chat/stream") {
    return openChatStream(req, res, {
      user,
      database,
      lastEventId: String(req.headers["last-event-id"] || "").trim(),
    });
  }

  if (method === "GET" && path === "/support-chat/me") {
    if (!isPartyActor(user)) {
      forbidden(send, res, "Operations reads the chat desk, not a personal thread.");
      return true;
    }
    send(res, 200, await partySnapshot(database, user));
    return true;
  }

  if (method === "GET" && path === "/support-chat/me/messages") {
    if (!isPartyActor(user)) {
      forbidden(send, res);
      return true;
    }
    const snapshot = await partySnapshot(database, user);
    if (!snapshot.thread) {
      send(res, 200, { messages: [] });
      return true;
    }
    send(res, 200, {
      messages: await listMessages(database, snapshot.thread.id, user.id, {
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit"),
      }),
    });
    return true;
  }

  if (method === "POST" && path === "/support-chat/me/threads") {
    if (!isPartyActor(user)) {
      forbidden(send, res);
      return true;
    }
    const thread = await database.transaction(
      () => openPartyDraft(database, user.id, actorRole(user), user.id),
      { lockKey: CHAT_LOCK },
    );
    send(res, 200, { thread });
    return true;
  }

  if (method === "POST" && path === "/support-chat/me/messages") {
    if (!isPartyActor(user)) {
      forbidden(send, res);
      return true;
    }
    if (tooManyRequests(`support-chat:${user.id}`, POST_LIMIT, POST_WINDOW_MS)) {
      rateLimited(send, res);
      return true;
    }
    const payload = await readBody(req);
    const parsed = parseMessageBody(payload.body);
    if (!parsed.ok) {
      invalid(send, res, parsed.message);
      return true;
    }
    const requestedId = typeof payload.threadId === "string" ? payload.threadId.trim() : "";
    if (requestedId) {
      const owned = await findThread(database, requestedId, user.id);
      if (!owned || !canViewThread(user, owned)) {
        notFound(send, res);
        return true;
      }
    }
    const posted = await database.transaction(
      () => postMessage(database, {
        threadId: requestedId || undefined,
        senderUserId: user.id,
        senderRole: actorRole(user),
        body: parsed.body,
        createParty: { userId: user.id, role: actorRole(user) },
        newThread: payload.newThread === true && !requestedId,
      }),
      { lockKey: CHAT_LOCK },
    );
    emitChatEvent(database, { type: "message", thread: posted.thread, message: posted.message });
    send(res, 201, posted);
    return true;
  }

  if (method === "PATCH" && path === "/support-chat/me/read") {
    if (!isPartyActor(user)) {
      forbidden(send, res);
      return true;
    }
    const threads = await listPartyThreads(database, user.id, actorRole(user), user.id);
    if (!threads.length) {
      send(res, 200, { thread: null, unreadCount: 0 });
      return true;
    }
    await database.transaction(async () => {
      for (const row of threads) {
        await markThreadRead(database, row.id, user.id);
      }
    }, { lockKey: CHAT_LOCK });
    const fresh = await findThread(database, threads[0].id, user.id);
    send(res, 200, { thread: fresh, unreadCount: 0 });
    return true;
  }

  if (method === "GET" && path === "/support-chat/threads") {
    if (!isStaffActor(user)) {
      forbidden(send, res, "Only Operations can open the chat desk.");
      return true;
    }
    send(res, 200, {
      threads: await listThreads(database, user.id, {
        role: url.searchParams.get("role"),
        q: url.searchParams.get("q"),
        limit: url.searchParams.get("limit"),
      }),
    });
    return true;
  }

  if (method === "GET" && threadMatch) {
    const thread = await findThread(database, threadMatch[1], user.id);
    if (!thread || !canViewThread(user, thread)) {
      notFound(send, res);
      return true;
    }
    if (isStaffActor(user) || isPartyActor(user)) {
      await markThreadRead(database, thread.id, user.id);
    }
    const fresh = await findThread(database, thread.id, user.id);
    send(res, 200, {
      thread: fresh,
      messages: await listMessages(database, thread.id, user.id, {
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit"),
      }),
    });
    return true;
  }

  if (method === "GET" && threadMessagesMatch) {
    const thread = await findThread(database, threadMessagesMatch[1], user.id);
    if (!thread || !canViewThread(user, thread)) {
      notFound(send, res);
      return true;
    }
    send(res, 200, {
      messages: await listMessages(database, thread.id, user.id, {
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit"),
      }),
    });
    return true;
  }

  if (method === "POST" && threadMessagesMatch) {
    if (!isStaffActor(user)) {
      forbidden(send, res, "Only Operations can reply on the desk.");
      return true;
    }
    if (tooManyRequests(`support-chat:${user.id}`, POST_LIMIT, POST_WINDOW_MS)) {
      rateLimited(send, res);
      return true;
    }
    const thread = await findThread(database, threadMessagesMatch[1], user.id);
    if (!thread) {
      notFound(send, res);
      return true;
    }
    const parsed = parseMessageBody((await readBody(req)).body);
    if (!parsed.ok) {
      invalid(send, res, parsed.message);
      return true;
    }
    const posted = await database.transaction(
      () => postMessage(database, {
        threadId: thread.id,
        senderUserId: user.id,
        senderRole: STAFF_ROLES.has(actorRole(user)) ? actorRole(user) : "ops_admin",
        body: parsed.body,
      }),
      { lockKey: CHAT_LOCK },
    );
    if (!posted) {
      notFound(send, res);
      return true;
    }
    emitChatEvent(database, { type: "message", thread: posted.thread, message: posted.message });
    send(res, 201, posted);
    return true;
  }

  if (method === "PATCH" && threadReadMatch) {
    const thread = await findThread(database, threadReadMatch[1], user.id);
    if (!thread || !canViewThread(user, thread)) {
      notFound(send, res);
      return true;
    }
    await database.transaction(
      () => markThreadRead(database, thread.id, user.id),
      { lockKey: CHAT_LOCK },
    );
    send(res, 200, { thread: await findThread(database, thread.id, user.id) });
    return true;
  }

  send(res, 404, { error: "not_found", path: pathname });
  return true;
}
