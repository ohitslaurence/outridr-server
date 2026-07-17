/**
 * Claude session transcripts — byte-offset windowed reads over a session's
 * JSONL file for the /session/<id> endpoint.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { sendJson } from "./http-util.mjs";

const SESSION_TAIL_BYTES = 256 * 1024;
const SESSION_CHUNK_BYTES = 512 * 1024;

const sessionPathCache = new Map();

function findSessionFile(config, sessionId) {
  const cached = sessionPathCache.get(sessionId);
  if (cached && existsSync(cached)) {
    return cached;
  }
  let projectDirs = [];
  try {
    projectDirs = readdirSync(config.claudeProjectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(config.claudeProjectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      sessionPathCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Byte-offset windows over the session JSONL, newline-aligned.
 *   (no params) → tail of SESSION_TAIL_BYTES; offset=N → forward from N
 *   end=N → the window ENDING at N (history pagination)
 * Responses carry both `start` and `offset`; torn trailing lines stay
 * unconsumed until their newline lands.
 */
export function serveSessionWindow(config, sessionId, url, res) {
  const filePath = findSessionFile(config, sessionId);
  if (!filePath) {
    sendJson(res, 404, { error: "session transcript not found" });
    return;
  }

  let size;
  let buffer;
  let start;
  let windowEnd;
  let skipFirstPartialLine;
  let readLength;
  try {
    size = statSync(filePath).size;
    const requested = Number.parseInt(url.searchParams.get("offset") ?? "-1", 10);
    const requestedEnd = Number.parseInt(url.searchParams.get("end") ?? "-1", 10);
    windowEnd = size;
    start = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, size) : -1;
    skipFirstPartialLine = false;
    if (Number.isFinite(requestedEnd) && requestedEnd >= 0) {
      windowEnd = Math.min(requestedEnd, size);
      start = Math.max(0, windowEnd - SESSION_TAIL_BYTES);
      skipFirstPartialLine = start > 0;
    } else if (start < 0) {
      start = Math.max(0, size - SESSION_TAIL_BYTES);
      skipFirstPartialLine = start > 0;
    }

    readLength = Math.min(windowEnd - start, SESSION_CHUNK_BYTES);
    buffer = Buffer.alloc(Math.max(readLength, 0));
    if (readLength > 0) {
      const fd = openSync(filePath, "r");
      try {
        readSync(fd, buffer, 0, readLength, start);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    console.error(`outridr: session transcript read failed: ${error.message}`);
    sessionPathCache.delete(sessionId);
    sendJson(res, 404, { error: "session transcript not found" });
    return;
  }

  let text = buffer.toString("utf8");
  let consumed = start;
  let alignedStart = start;
  if (skipFirstPartialLine) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline === -1) {
      text = "";
      consumed = windowEnd;
      alignedStart = windowEnd;
    } else {
      const skipped = Buffer.byteLength(text.slice(0, firstNewline + 1), "utf8");
      consumed += skipped;
      alignedStart += skipped;
      text = text.slice(firstNewline + 1);
    }
  }

  const entries = [];
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);

  // Oversized-line guard: a single JSON line larger than the read window would
  // leave `consumed` stuck forever (the stream freezes at that point). If we
  // filled the chunk with no newline and there's more file beyond, skip past
  // the oversized line so the stream keeps flowing. That entry — almost always
  // a huge tool result we'd truncate anyway — is dropped.
  if (
    complete === "" &&
    !skipFirstPartialLine &&
    readLength === SESSION_CHUNK_BYTES &&
    start + readLength < windowEnd
  ) {
    consumed = nextNewlineOffset(filePath, start + readLength, windowEnd);
    alignedStart = consumed;
  } else {
    consumed += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* torn or corrupt line — skip */
      }
    }
  }

  sendJson(res, 200, {
    start: alignedStart,
    offset: consumed,
    size,
    entries,
    more: windowEnd - consumed > SESSION_CHUNK_BYTES / 2,
  });
}

/** First offset strictly after `from` that follows a newline; `limit` if none. */
function nextNewlineOffset(filePath, from, limit) {
  const fd = openSync(filePath, "r");
  const step = 64 * 1024;
  const buf = Buffer.alloc(step);
  try {
    let pos = from;
    while (pos < limit) {
      const n = readSync(fd, buf, 0, Math.min(step, limit - pos), pos);
      if (n <= 0) {
        break;
      }
      const idx = buf.subarray(0, n).indexOf(0x0a);
      if (idx !== -1) {
        return pos + idx + 1;
      }
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return limit;
}
