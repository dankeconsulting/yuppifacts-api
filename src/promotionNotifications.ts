import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { query } from "./db.js";

const client = new SESv2Client({ region: process.env.AWS_REGION });
const fromEmail = process.env.AWS_SES_FROM_EMAIL;
const replyTo = process.env.PROMO_REPLY_TO_EMAIL ?? "promo@yuppifacts.com";
type Template = "contract_received" | "voucher_received" | "advisor_assigned" | "panel_access" | "payment_reminder";
type OutboxRow = { id:string; recipient:string; reply_to:string; template:Template; payload:Record<string,string>; attempts:number };

function escapeHtml(value:string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character] ?? character);
}

function message(template:Template, payload:Record<string,string>) {
  const name = payload.fullName || "";
  if (template === "contract_received") return { subject: "Gracias por contratar la promoción de YuppiFacts", text: `Hola ${name}, recibimos tu contratación promocional. Te avisaremos los siguientes pasos.` };
  if (template === "payment_reminder") {
    const ticketsUrl=payload.ticketsUrl;
    const safeName=escapeHtml(name);
    return { subject:"Continúa tu suscripción a YuppiFacts", text:`Hola ${name},\n\nVimos que iniciaste tu suscripción a YuppiFacts. Si ya realizaste tu pago, puedes adjuntar tu voucher; si aún no, puedes volver a Mercado Pago para completarlo.\n\nContinúa aquí: ${ticketsUrl}\n\nEquipo YuppiFacts`, html:`<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#1d2433"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:auto;background:#ffffff"><tr><td style="padding:42px 48px"><p style="margin:0;color:#8056dc;font-size:12px;font-weight:700;letter-spacing:1px">YUPPIFACTS</p><h1 style="margin:18px 0;font-size:30px;color:#1b202d">Continúa tu suscripción</h1><p style="font-size:17px;line-height:1.6">Hola ${safeName},</p><p style="font-size:17px;line-height:1.6">Vimos que iniciaste tu suscripción. Si ya realizaste tu pago, adjunta tu voucher; si aún no, vuelve a Mercado Pago para completarlo.</p><a href="${ticketsUrl}" style="display:inline-block;margin-top:16px;padding:15px 22px;background:#8056dc;color:#ffffff;text-decoration:none;font-weight:700">Continuar mi suscripción</a><p style="margin-top:30px;color:#6e7890;font-size:13px;line-height:1.5">Desde esta liga podrás realizar tu pago, adjuntar tu voucher o salir del proceso.</p></td></tr></table></td></tr></table></body></html>`};
  }
  if (template === "voucher_received") {
    const url=(process.env.PROMOTION_TICKETS_URL ?? "https://tickets.yuppifacts.com").replace(/\/$/, "");
    const safeName=escapeHtml(name);
    return {
      subject: "Recibimos tu voucher — YuppiFacts",
      text: `Hola ${name},\n\n¡Bienvenido a YuppiFacts! Hemos recibido tu voucher y tu suscripción. Nuestro equipo verificará tu pago y te asignará un asesor personal para continuar con la activación de tu cuenta.\n\nPuedes confirmar tu suscripción o adjuntar tu comprobante aquí: ${url}\n\nTe iremos avisando por correo cuando validemos tu voucher, cuando tu cuenta sea activada y cuando tu perfil esté en línea.\n\nSaludos cordiales,\nEquipo YuppiFacts\n\nRecibiste este correo porque existe una suscripción asociada a tus datos en YuppiFacts. © 2027 YuppiFacts. Todos los derechos reservados.`,
      html: `<!doctype html><html lang="es"><body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#1d2433"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff"><tr><td style="padding:42px 52px 30px"><div style="font-size:28px;line-height:1;font-weight:800;letter-spacing:-1px;color:#1a2030"><span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;margin-right:10px;border-radius:10px;background:#9c7af2;color:#171126;font-size:21px;vertical-align:middle">Y</span><span style="vertical-align:middle">YuppiFacts</span></div></td></tr><tr><td style="padding:4px 52px 0;font-size:20px;line-height:1.45;color:#202633">Hola ${safeName},</td></tr><tr><td style="padding:20px 52px 0"><h1 style="margin:0;font-size:34px;line-height:1.16;letter-spacing:-1px;color:#1b202d">¡Bienvenido a <span style="color:#8056dc">YuppiFacts</span>!</h1></td></tr><tr><td style="padding:24px 52px 0;font-size:18px;line-height:1.58;color:#3e4b61">Hemos recibido tu voucher y tu suscripción. Nuestro equipo verificará el pago y te asignará un asesor personal para continuar con la activación de tu cuenta.</td></tr><tr><td style="padding:28px 52px 8px"><a href="${url}" style="display:inline-block;padding:16px 25px;border-radius:10px;background:#8056dc;color:#ffffff;font-size:17px;line-height:1;text-decoration:none;font-weight:700">Confirmar mi suscripción</a></td></tr><tr><td style="padding:30px 52px 36px;font-size:18px;line-height:1.58;color:#3e4b61">Te iremos avisando por correo cuando validemos tu voucher, cuando tu cuenta sea activada y cuando tu perfil esté en línea.<br><br>Saludos cordiales,<br><strong style="color:#202633">Equipo YuppiFacts</strong></td></tr><tr><td style="border-top:1px solid #dde1e9;padding:28px 52px 0;font-size:13px;line-height:1.55;color:#6e7890">Recibiste este correo porque existe una suscripción asociada a tus datos en YuppiFacts.</td></tr><tr><td style="padding:22px 52px 12px;font-size:13px;line-height:1.55;color:#6e7890">© 2027 YuppiFacts. Todos los derechos reservados.</td></tr></table></td></tr></table></body></html>`
    };
  }
  if (template === "advisor_assigned") return { subject: "Tu asesor de YuppiFacts", text: `Hola ${name}, tu asesor asignado es ${payload.advisorName || "nuestro equipo"}. Te contactará para continuar.` };
  return { subject: "Tu acceso a YuppiFacts está listo", text: `Hola ${name}, tu cuenta promocional ya está activa. Puedes ingresar a tu panel de trabajo.` };
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
    const sent = await client.send(new SendEmailCommand({ FromEmailAddress: fromEmail, ReplyToAddresses:[item.reply_to], Destination:{ToAddresses:[item.recipient]}, Content:{Simple:{Subject:{Data:content.subject,Charset:"UTF-8"},Body:{Text:{Data:content.text,Charset:"UTF-8"},...("html" in content ? {Html:{Data:content.html,Charset:"UTF-8"}} : {})}}} }));
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
