import fs from "node:fs/promises";
import nodemailer from "nodemailer";

import { escapeHtml, toHtmlParagraphs } from "./support-html.js";
import { interpretSmtpResult } from "./support-smtp.js";

export function emailConfigured(env = process.env) {
  return Boolean(String(env.EMAIL_USER || "").trim() && String(env.EMAIL_PASSWORD || "").trim());
}

export function buildReplyEmail(ticket, replyMessage) {
  const year = new Date().getFullYear();
  const shortId = ticket.id.slice(0, 8);
  const safeName = escapeHtml(ticket.name);
  const safeSubject = escapeHtml(ticket.subject);
  const messageHtml = toHtmlParagraphs(ticket.message);
  const replyHtml = toHtmlParagraphs(replyMessage);

  return {
    subject: `Re: ${ticket.subject} (Ticket #${shortId})`,
    text: `Dear ${ticket.name},\n\nRegarding your ticket "${ticket.subject}":\n\n${ticket.message}\n\n---\n\nAdmin Reply:\n${replyMessage}\n\nBest regards,\nGrid Support Team`,
    html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #050505; padding: 40px 20px; color: #ffffff;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #111111; border-radius: 16px; overflow: hidden; border: 1px solid #222222;">
                <tr>
                  <td style="padding: 30px; text-align: center; border-bottom: 1px solid #222222;">
                    <table border="0" cellpadding="0" cellspacing="3" style="display: inline-table; vertical-align: middle;">
                      <tr>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#FFDE58; border-radius:50%;"></td>
                      </tr>
                      <tr>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#8A8A8A; border-radius:50%;"></td>
                      </tr>
                      <tr>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#ffffff; border-radius:50%;"></td>
                        <td style="width:8px; height:8px; background-color:#8A8A8A; border-radius:50%;"></td>
                      </tr>
                    </table>
                    <span style="font-size: 28px; font-weight: 800; color: #ffffff; vertical-align: middle; margin-left: 12px; letter-spacing: 3px;">GRIDGO</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 40px 30px;">
                    <h2 style="margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Support Reply</h2>
                    <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.5; color: #E5E7EB;">
                      Hi <strong>${safeName}</strong>,
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.5; color: #9CA3AF;">
                      Thank you for reaching out to us. We have received your inquiry regarding <strong>"${safeSubject}"</strong>.
                    </p>
                    <div style="background-color: #1A1A1A; border-left: 4px solid #333333; padding: 16px 20px; border-radius: 4px; margin-bottom: 24px;">
                      <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 1px;">Your Message</p>
                      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #D1D5DB; font-style: italic;">
                        ${messageHtml}
                      </p>
                    </div>
                    <div style="background-color: rgba(255, 222, 88, 0.05); border: 1px solid rgba(255, 222, 88, 0.2); padding: 24px; border-radius: 12px; margin-bottom: 30px;">
                      <p style="margin: 0 0 12px 0; font-size: 13px; font-weight: 700; color: #FFDE58; text-transform: uppercase; letter-spacing: 1px;">Admin Response</p>
                      <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #ffffff;">
                        ${replyHtml}
                      </p>
                    </div>
                    <p style="margin: 0; font-size: 15px; line-height: 1.5; color: #E5E7EB;">
                      Best regards,<br/>
                      <strong style="color: #ffffff;">The GRIDGO Team</strong>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 30px; text-align: center; border-top: 1px solid #222222; background-color: #0A0A0A;">
                    <p style="margin: 0; font-size: 12px; color: #6B7280;">
                      &copy; ${year} GRIDGO. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </div>
          `,
  };
}

function optionalEnv(env, name) {
  return String(env[name] || "").trim();
}

async function captureSendMail(capturePath, mail) {
  await fs.appendFile(capturePath, `${JSON.stringify(mail)}\n`);
  return {
    accepted: [mail.to],
    rejected: [],
    response: "250 2.0.0 OK gsmtp",
    messageId: "<mock@gridgo>",
  };
}

export function createSupportMailer(env = process.env, { createTransport = nodemailer.createTransport } = {}) {
  const user = optionalEnv(env, "EMAIL_USER");
  const pass = optionalEnv(env, "EMAIL_PASSWORD");
  const capturePath = optionalEnv(env, "GRIDGO_SUPPORT_MAIL_CAPTURE");

  let sendMail = null;
  if (capturePath && user && pass) {
    sendMail = (mail) => captureSendMail(capturePath, mail);
  } else if (user && pass) {
    const transporter = createTransport({
      service: "gmail",
      auth: { user, pass },
    });
    sendMail = (mail) => transporter.sendMail(mail);
  }

  return {
    configured: Boolean(sendMail),
    async sendReplyEmail(ticket, replyMessage) {
      if (!sendMail) {
        return { sent: false, error: "EMAIL_USER or EMAIL_PASSWORD is not configured." };
      }
      const content = buildReplyEmail(ticket, replyMessage);
      try {
        const info = await sendMail({
          from: `"GridGO Support" <${user}>`,
          replyTo: user,
          to: ticket.email,
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
        const interpreted = interpretSmtpResult(info);
        if (!interpreted.sent) return { sent: false, error: interpreted.error };
        return { sent: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { sent: false, error: message };
      }
    },
  };
}
