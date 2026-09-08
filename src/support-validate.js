const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateTicket(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const record = body;
  const name = asTrimmedString(record.name);
  const email = asTrimmedString(record.email);
  const subject = asTrimmedString(record.subject);
  const message = asTrimmedString(record.message);

  if (!name) return { ok: false, message: "Name is required." };
  if (name.length > 100) return { ok: false, message: "Name must be 100 characters or fewer." };
  if (!email) return { ok: false, message: "Email is required." };
  if (!EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (!subject) return { ok: false, message: "Subject is required." };
  if (subject.length > 200) return { ok: false, message: "Subject must be 200 characters or fewer." };
  if (!message) return { ok: false, message: "Message is required." };
  if (message.length > 5000) return { ok: false, message: "Message must be 5000 characters or fewer." };

  return { ok: true, value: { name, email, subject, message } };
}

export function validateReply(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const replyMessage = asTrimmedString(body.replyMessage);
  if (!replyMessage) return { ok: false, message: "Reply message is required." };
  if (replyMessage.length > 5000) {
    return { ok: false, message: "Reply must be 5000 characters or fewer." };
  }
  return { ok: true, replyMessage };
}

export function validateLogin(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const username = asTrimmedString(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return { ok: false, message: "Username and password are required." };
  }
  return { ok: true, username, password };
}
