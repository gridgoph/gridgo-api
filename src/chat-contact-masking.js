// Deterministic text-only privacy filter. The original is retained separately
// for staff evidence; never use it in party responses, notifications or logs.
const SEP = '[\\s().\\-]*';
const DOT = '(?:\\s*(?:\\.|\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\bdot\\b)\\s*)';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = `${LABEL}(?:${DOT}${LABEL})*${DOT}(?:com|net|org|ph|io|co|me|app|dev|edu|gov|info|biz|shop|site|online|xyz|link|cloud|store|social|design|art|uk|us|au|sg)`;
const WORD_DOT = '(?:\\s*(?:\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\bdot\\b)\\s*)';
const EMAIL_DOMAIN = `${LABEL}(?:\\.${LABEL})*(?:\\.|${WORD_DOT})[a-z]{2,24}`;
const AT = '(?:\\s*(?:@|\\(\\s*at\\s*\\)|\\[\\s*at\\s*\\]|\\bat\\b)\\s*)';
const TOKEN_TAIL = '(?::\\d{1,5})?(?:[/#?][^\\s<>]*)?';
const EMAIL = new RegExp(`(?<![\\w.+-])[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+${AT}(?:${EMAIL_DOMAIN}|${DOMAIN})(?![\\w-])`, 'giu');
const URL = new RegExp(`(?<![\\w@])(?:(?:https?|hxxps?)\\s*:\\s*[/\\\\]\\s*[/\\\\]\\s*|www${DOT})?${DOMAIN}(?::\\d{1,5})?(?:[/#?][^\\s<>]*)?(?![\\w-])`, 'giu');
const PROTOCOL_URL = /\b(?:https?|hxxps?|ftp):\/\/[^\s<>]+/giu;
const BARE_URL = new RegExp(`(?<![\\w@])(?:www\\.)?${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,24}(?::\\d{1,5})?(?:[/#?][^\\s<>]*)?(?![\\w-])`, 'giu');
const INTERNATIONAL_PHONE = /(?<![\p{L}\d])\+\s*\d(?:[\s().-]*\d){7,14}(?!\d)/gu;
const PHONE = new RegExp(`(?<![\\p{L}\\d])(?:\\(${SEP})?(?:(?:\\+${SEP})?6${SEP}3${SEP}\\)?${SEP}9(?:${SEP}\\d){9}|0${SEP}9(?:${SEP}\\d){9}|(?:\\+${SEP})?6${SEP}3${SEP}\\)?${SEP}[2-8](?:${SEP}\\d){8,9}|0${SEP}[2-8](?:${SEP}\\d){8,9})\\)?(?!\\d)`, 'gu');
const HANDLE = new RegExp(String.raw`(?:(?<![\w@])@[a-z0-9_][a-z0-9_.-]*|\b(?:ig|instagram|fb|facebook|tiktok|telegram|viber|whatsapp|messenger|twitter|snapchat)\s*(?:(?:handle|username|account)\s*)?(?::|=|\bis\b)\s*@?[a-z0-9_][a-z0-9_.-]*)${TOKEN_TAIL}`, 'giu');

export function maskChatContacts(body) {
  const text = body.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  // Detect against the original text: an email-shaped phrase such as 'page at
  // facebook.com' must not erase the domain before URL detection sees its path.
  // Merge overlaps so an email/phone inside a URL cannot leave query fragments.
  const matches = [EMAIL, URL, PROTOCOL_URL, BARE_URL, PHONE, INTERNATIONAL_PHONE, HANDLE]
    .flatMap(pattern => [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length })))
    .sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const match of matches) {
    const previous = ranges.at(-1);
    if (previous && match.start < previous.end) previous.end = Math.max(previous.end, match.end);
    else ranges.push(match);
  }
  let masked = '', cursor = 0;
  for (const { start, end } of ranges) {
    masked += `${text.slice(cursor, start)}[contact hidden]`;
    cursor = end;
  }
  return { text: masked + text.slice(cursor), contactAttempt: ranges.length > 0 };
}
