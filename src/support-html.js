export function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toHtmlParagraphs(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br/>");
}
