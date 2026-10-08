// Transactional email through Resend's HTTP API. Without RESEND_API_KEY, messages are logged instead.
// Every message is also kept in `outbox` (last 200) so tests and the admin console can see what went out.

export const outbox = [];

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function makeMailer(cfg, log = console) {
  return async function send({ to, subject, lines, cta }) {
    if (!to) return;
    const text = [...lines, cta ? `\n${cta.label}: ${cta.url}` : "", `\n— ${cfg.brand}${cfg.supportEmail ? ` · ${cfg.supportEmail}` : ""}`].join("\n");
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#13202A;max-width:560px">
      ${lines.map(l => (l === "" ? "<br>" : `<p style="margin:0 0 10px">${esc(l)}</p>`)).join("")}
      ${cta ? `<p style="margin:18px 0"><a href="${esc(cta.url)}" style="background:#9E226C;color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>` : ""}
      <p style="color:#566874;font-size:13px;margin-top:24px">${esc(cfg.brand)}${cfg.supportEmail ? ` · ${esc(cfg.supportEmail)}` : ""}${cfg.supportPhone ? ` · ${esc(cfg.supportPhone)}` : ""}</p></div>`;
    const msg = { to, subject, text, at: Date.now() };
    outbox.push(msg); if (outbox.length > 200) outbox.shift();
    if (!cfg.resendKey) { log.info?.(`[email:not-sent] to=${to} subject="${subject}"`); return; }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.emailFrom, to: [to], subject, text, html, reply_to: cfg.supportEmail || undefined }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) log.error?.(`[email:failed] ${res.status} to=${to} ${await res.text().catch(() => "")}`);
    } catch (err) { log.error?.(`[email:failed] to=${to} ${err.message}`); }
  };
}
