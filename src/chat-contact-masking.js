// Deterministic text-only privacy filter. The original is retained separately
// for staff evidence; never use it in party responses, notifications or logs.
const SEP = '[\\s().\\-]*';
const DOT = '(?:\\s*(?:\\.|\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\bdot\\b)\\s*)';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = `${LABEL}(?:${DOT}${LABEL})*${DOT}(?:com|net|org|ph|io|co|me|app|dev|edu|gov|info|biz|shop|site|online|xyz|link|cloud|store|social|design|art|uk|us|au|sg)`;
const WORD_DOT = '(?:\\s*(?:\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\bdot\\b)\\s*)';
const EMAIL_DOMAIN = `${LABEL}(?:\\.${LABEL})*(?:\\.|${WORD_DOT})[a-z]{2,24}`;
const AT = '(?:\\s*(?:@|\\(\\s*at\\s*\\)|\\[\\s*at\\s*\\]|\\bat\\b)\\s*)';
const EMAIL = new RegExp(`(?<![\\w.+-])[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+${AT}(?:${EMAIL_DOMAIN}|${DOMAIN})(?![\\w-])`, 'giu');
const URL = new RegExp(`(?<![\\w@])(?:(?:https?|hxxps?)\\s*:\\s*[/\\\\]\\s*[/\\\\]\\s*|www${DOT})?${DOMAIN}(?::\\d{1,5})?(?:[/#?][^\\s<>]*)?(?![\\w-])`, 'giu');
const PROTOCOL_URL = /\b(?:https?|hxxps?|ftp):\/\/[^\s<>]+/giu;
const BARE_URL = new RegExp(`(?<![\\w@])(?:www\\.)?${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,24}(?::\\d{1,5})?(?:[/#?][^\\s<>]*)?(?![\\w-])`, 'giu');
const INTERNATIONAL_PHONE = /(?<![\p{L}\d])\+\s*\d(?:[\s().-]*\d){7,14}(?!\d)/gu;
const PHONE = new RegExp(`(?<![\\p{L}\\d])(?:\\(${SEP})?(?:(?:\\+${SEP})?6${SEP}3${SEP}\\)?${SEP}9(?:${SEP}\\d){9}|0${SEP}9(?:${SEP}\\d){9}|(?:\\+${SEP})?6${SEP}3${SEP}\\)?${SEP}[2-8](?:${SEP}\\d){8,9}|0${SEP}[2-8](?:${SEP}\\d){8,9})\\)?(?!\\d)`, 'gu');
const HANDLE = /(?<![\w@])@[a-z0-9_][a-z0-9_.-]{0,63}|\b(?:ig|instagram|fb|facebook|tiktok|telegram|viber|whatsapp|messenger|twitter|snapchat)\s*(?:(?:handle|username|account)\s*)?(?::|=|\bis\b)\s*@?[a-z0-9_][a-z0-9_.-]{0,63}/giu;

export function maskChatContacts(body) {
  let text = body.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  let contactAttempt = false;
  for (const pattern of [EMAIL, URL, PROTOCOL_URL, BARE_URL, PHONE, INTERNATIONAL_PHONE, HANDLE]) {
    text = text.replace(pattern, () => { contactAttempt = true; return '[contact hidden]'; });
  }
  return { text, contactAttempt };
}
