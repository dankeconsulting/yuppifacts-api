import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { query } from "./db.js";

const client = new SESv2Client({ region: process.env.AWS_REGION });
const fromEmail = process.env.AWS_SES_FROM_EMAIL;
const senderName = "YuppiFacts AI® Notificaciones";
const replyTo = process.env.PROMO_REPLY_TO_EMAIL ?? "promo@yuppifacts.com";
const brandName = "YuppiFacts AI®";
const brandIsoUrl = "https://yuppifacts.com/brand/yuppifacts-email-iso-transparent.png";
const emailBrandHeader = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:0 11px 0 0"><img src="${brandIsoUrl}" width="24" height="24" alt="YuppiFacts AI®" style="display:block;width:24px;height:24px;border:0;outline:none;text-decoration:none" /></td><td style="font-size:24px;line-height:1;font-weight:800;letter-spacing:-.8px;color:#1a2030;vertical-align:middle">YuppiFacts AI<sup style="font-size:10px;line-height:0">®</sup></td></tr></table>`;
type Template = "contract_received" | "voucher_received" | "payment_verified" | "advisor_assigned" | "panel_access" | "payment_reminder";
type OutboxRow = { id:string; recipient:string; reply_to:string; template:Template; payload:Record<string,string>; attempts:number };

function escapeHtml(value:string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character] ?? character);
}

function formattedSender(address:string) {
  const mailbox = address.match(/<([^>]+)>/)?.[1] ?? address.trim();
  return `"${senderName}" <${mailbox}>`;
}

function brandedEmail(title:string, content:string) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2433"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff"><tr><td style="padding:40px 48px 22px">${emailBrandHeader}</td></tr><tr><td style="padding:0 48px"><h1 style="margin:0 0 18px;font-size:30px;line-height:1.18;letter-spacing:-1px;color:#1b202d">${title}</h1>${content}</td></tr><tr><td style="padding:30px 48px 34px;color:#6e7890;font-size:13px;line-height:1.5">© 2027 ${brandName}. Todos los derechos reservados.</td></tr></table></td></tr></table></body></html>`;
}

function message(template:Template, payload:Record<string,string>) {
  const name = payload.fullName || "";
  if (template === "contract_received") return { subject: `Gracias por contratar la promoción de ${brandName}`, text: `Hola ${name}, recibimos tu contratación promocional de ${brandName}. Te avisaremos los siguientes pasos.`, html: brandedEmail("Recibimos tu contratación", `<p style="margin:0;font-size:17px;line-height:1.6">Hola ${escapeHtml(name)},</p><p style="font-size:17px;line-height:1.6">Recibimos tu contratación promocional de ${brandName}. Te avisaremos los siguientes pasos.</p>`) };
  if (template === "payment_reminder") {
    const ticketsUrl=payload.ticketsUrl;
    const safeName=escapeHtml(name);
    return { subject:`Continúa tu suscripción a ${brandName}`, text:`Hola ${name},\n\nVimos que iniciaste tu suscripción a ${brandName}. Si ya realizaste tu pago, puedes adjuntar tu voucher; si aún no, puedes volver a Mercado Pago para completarlo.\n\nContinúa aquí: ${ticketsUrl}\n\nEquipo ${brandName}`, html:`<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#1d2433"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:auto;background:#ffffff"><tr><td style="padding:42px 48px">${emailBrandHeader}<h1 style="margin:18px 0;font-size:30px;color:#1b202d">Continúa tu suscripción</h1><p style="font-size:17px;line-height:1.6">Hola ${safeName},</p><p style="font-size:17px;line-height:1.6">Vimos que iniciaste tu suscripción a ${brandName}. Si ya realizaste tu pago, adjunta tu voucher; si aún no, vuelve a Mercado Pago para completarlo.</p><a href="${ticketsUrl}" style="display:inline-block;margin-top:16px;padding:15px 22px;background:#8056dc;color:#ffffff;text-decoration:none;font-weight:700">Continuar mi suscripción</a><p style="margin-top:30px;color:#6e7890;font-size:13px;line-height:1.5">Desde esta liga podrás realizar tu pago, adjuntar tu voucher o salir del proceso.</p></td></tr></table></td></tr></table></body></html>`};
  }
  if (template === "voucher_received") {
    const url=(process.env.PROMOTION_TICKETS_URL ?? "https://tickets.yuppifacts.com").replace(/\/$/, "");
    const safeName=escapeHtml(name);
    return {
      subject: brandName,
      text: `Hola ${name},\n\n¡Bienvenido(a) a ${brandName}! Hemos recibido tu voucher y tu suscripción. Nuestro equipo verificará tu pago y te asignará un asesor personal para continuar con la activación de tu cuenta.\n\nPuedes confirmar tu suscripción o adjuntar tu comprobante aquí: ${url}\n\nTe iremos avisando por correo cuando validemos tu voucher, cuando tu cuenta sea activada y cuando tu perfil esté en línea.\n\nSaludos cordiales,\nEquipo ${brandName}\n\nRecibiste este correo porque existe una suscripción asociada a tus datos en ${brandName}. © 2027 ${brandName}. Todos los derechos reservados.`,
      html: `<!doctype html><html lang="es"><body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2433"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff"><tr><td style="padding:42px 52px 30px">${emailBrandHeader}</td></tr><tr><td style="padding:4px 52px 0;font-size:20px;line-height:1.45;color:#202633">Hola ${safeName},</td></tr><tr><td style="padding:20px 52px 0"><h1 style="margin:0;font-size:32px;line-height:1.16;letter-spacing:-1px;color:#1b202d;white-space:nowrap">¡Bienvenido(a) a <span style="color:#8056dc">${brandName}</span>!</h1></td></tr><tr><td style="padding:24px 52px 0;font-size:18px;line-height:1.58;color:#3e4b61">Hemos recibido tu voucher y tu suscripción. Nuestro equipo verificará el pago y te asignará un asesor personal para continuar con la activación de tu cuenta.</td></tr><tr><td style="padding:28px 52px 8px"><a href="${url}" style="display:inline-block;padding:16px 25px;border-radius:10px;background:#8056dc;color:#ffffff;font-size:17px;line-height:1;text-decoration:none;font-weight:700">Confirmar mi suscripción</a></td></tr><tr><td style="padding:30px 52px 36px;font-size:18px;line-height:1.58;color:#3e4b61">Te iremos avisando por correo cuando validemos tu voucher, cuando tu cuenta sea activada y cuando tu perfil esté en línea.<br><br>Saludos cordiales,<br><strong style="color:#202633">Equipo ${brandName}</strong></td></tr><tr><td style="border-top:1px solid #dde1e9;padding:28px 52px 0;font-size:13px;line-height:1.55;color:#6e7890">Recibiste este correo porque existe una suscripción asociada a tus datos en ${brandName}.</td></tr><tr><td style="padding:22px 52px 12px;font-size:13px;line-height:1.55;color:#6e7890">© 2027 ${brandName}. Todos los derechos reservados.</td></tr></table></td></tr></table></body></html>`
    };
  }
  if (template === "payment_verified") {
    return {
      subject: `Hemos validado tu pago | ${brandName}`,
      text: `Hola ${name},\n\nHemos validado tu pago. Ahora continuamos con la configuración de tu cuenta.\n\nLa activación de tu cuenta puede tardar de 72 horas hábiles a 7 días hábiles, según el alcance de las solicitudes y el proceso de validación.\n\nLa vigencia de tu membresía comenzará únicamente cuando ${brandName} confirme la activación de tu cuenta, no desde el momento del pago.\n\nTe avisaremos por correo cuando tu cuenta esté en línea.\n\nEquipo ${brandName}`,
      html: brandedEmail("Hemos validado tu pago", `<p style="margin:0;font-size:17px;line-height:1.6">Hola ${escapeHtml(name)},</p><p style="font-size:17px;line-height:1.6">Hemos validado tu pago. Ahora continuamos con la configuración de tu cuenta.</p><p style="font-size:17px;line-height:1.6">La activación de tu cuenta puede tardar de <strong>72 horas hábiles a 7 días hábiles</strong>, según el alcance de las solicitudes y el proceso de validación.</p><p style="font-size:17px;line-height:1.6">La vigencia de tu membresía comenzará únicamente cuando ${brandName} confirme la activación de tu cuenta, no desde el momento del pago.</p><p style="font-size:17px;line-height:1.6">Te avisaremos por correo cuando tu cuenta esté en línea.</p>`),
    };
  }
  if (template === "advisor_assigned") return { subject: `Tu asesor de ${brandName}`, text: `Hola ${name}, tu asesor asignado de ${brandName} es ${payload.advisorName || "nuestro equipo"}. Te contactará para continuar.`, html: brandedEmail("Tu asesor está listo", `<p style="margin:0;font-size:17px;line-height:1.6">Hola ${escapeHtml(name)},</p><p style="font-size:17px;line-height:1.6">Tu asesor asignado de ${brandName} es ${escapeHtml(payload.advisorName || "nuestro equipo")}. Te contactará para continuar.</p>`) };
  return { subject: `Tu cuenta ya está en línea | ${brandName}`, text: `Hola ${name},\n\nTu cuenta de ${brandName} ya está en línea y puedes ingresar a tu panel de trabajo.\n\nA partir de hoy inicia la vigencia de tu membresía.\n\nEquipo ${brandName}`, html: brandedEmail("Tu cuenta ya está en línea", `<p style="margin:0;font-size:17px;line-height:1.6">Hola ${escapeHtml(name)},</p><p style="font-size:17px;line-height:1.6">Tu cuenta de ${brandName} ya está en línea y puedes ingresar a tu panel de trabajo.</p><p style="font-size:17px;line-height:1.6">A partir de hoy inicia la vigencia de tu membresía.</p>`) };
}

export async function queuePromotionEmail(input:{voucherId?:string;promotionId?:string;recipient:string;template:Template;payload:Record<string,string>;deliverAfter?:Date}) {
  const result = await query<{id:string}>(`INSERT INTO promotion_notification_outbox (voucher_id, promotion_contract_id, recipient, reply_to, template, payload, deliver_after)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (promotion_contract_id) WHERE template='payment_reminder' DO NOTHING RETURNING id`, [input.voucherId ?? null,input.promotionId ?? null, input.recipient, replyTo, input.template, JSON.stringify(input.payload),input.deliverAfter ?? new Date()]);
  return result.rows[0]?.id ?? null;
}

export async function deliverPromotionEmail(id:string) {
  const result = await query<OutboxRow>(`UPDATE promotion_notification_outbox SET status='sending',attempts=attempts+1
    WHERE id=$1 AND status IN ('pending','failed') RETURNING id,recipient,reply_to,template,payload,attempts`, [id]);
  const item = result.rows[0];
  if (!item) return;
  if (!fromEmail) {
    await query("UPDATE promotion_notification_outbox SET status='failed',last_error='AWS_SES_FROM_EMAIL is not configured' WHERE id=$1", [item.id]);
    return;
  }
  const content = message(item.template, item.payload);
  try {
    const sent = await client.send(new SendEmailCommand({ FromEmailAddress: formattedSender(fromEmail), ReplyToAddresses:[item.reply_to], Destination:{ToAddresses:[item.recipient]}, Content:{Simple:{Subject:{Data:content.subject,Charset:"UTF-8"},Body:{Text:{Data:content.text,Charset:"UTF-8"},...("html" in content ? {Html:{Data:content.html,Charset:"UTF-8"}} : {})}}} }));
    await query("UPDATE promotion_notification_outbox SET status='sent',provider_message_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[item.id,sent.MessageId ?? null]);
  } catch (error) {
    await query("UPDATE promotion_notification_outbox SET status='failed',last_error=$2 WHERE id=$1",[item.id,error instanceof Error ? error.message.slice(0,500) : "SES delivery failed"]);
  }
}

export async function retryFailedPromotionEmails() {
  const pending = await query<{id:string}>(`SELECT id FROM promotion_notification_outbox
    WHERE status = 'failed' AND attempts < 3
    ORDER BY created_at ASC
    LIMIT 50`);
  for (const item of pending.rows) await deliverPromotionEmail(item.id);
}

export async function deliverDuePromotionPaymentReminders() {
  await query(`UPDATE promotion_notification_outbox reminder SET status='cancelled'
    WHERE reminder.template='payment_reminder' AND reminder.status='pending'
      AND EXISTS (SELECT 1 FROM promotion_vouchers voucher WHERE voucher.promotion_contract_id=reminder.promotion_contract_id)`);
  const due=await query<{id:string}>(`SELECT reminder.id FROM promotion_notification_outbox reminder
    WHERE reminder.template='payment_reminder' AND reminder.status='pending' AND reminder.deliver_after<=now()
      AND NOT EXISTS (SELECT 1 FROM promotion_vouchers voucher WHERE voucher.promotion_contract_id=reminder.promotion_contract_id)
    ORDER BY reminder.deliver_after ASC LIMIT 50`);
  for(const item of due.rows) await deliverPromotionEmail(item.id);
}
