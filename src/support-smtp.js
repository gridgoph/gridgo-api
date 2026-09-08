export function interpretSmtpResult(info) {
  const accepted = info?.accepted ?? [];
  const rejected = info?.rejected ?? [];
  if (rejected.length > 0 || accepted.length === 0) {
    return {
      sent: false,
      error: `Gmail rejected the message (${info?.response ?? "no SMTP response"}).`,
      messageId: info?.messageId,
      response: info?.response,
    };
  }
  return {
    sent: true,
    messageId: info?.messageId,
    response: info?.response,
  };
}
