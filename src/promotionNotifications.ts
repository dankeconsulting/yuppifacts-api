import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { query } from "./db.js";

const client = new SESv2Client({ region: process.env.AWS_REGION });
const fromEmail = process.env.AWS_SES_FROM_EMAIL;
const replyTo = process.env.PROMO_REPLY_TO_EMAIL ?? "promo@yuppifacts.com";
type Template = "contract_received" | "voucher_received" | "advisor_assigned" | "panel_access";
type OutboxRow = { id:string; recipient:string; reply_to:string; template:Template; payload:Record<string,string>; attempts:number };

function message(template:Template, payload:Record<string,string>) {
  const name = payload.fullName || "";
  if (template === "contract_received") return { subject: "Gracias por contratar la promoción de YuppiFacts", text: `Hola ${name}, recibimos tu contratación promocional. Te avisaremos los siguientes pasos.` };
  if (template === "voucher_received") return { subject: "Recibimos tu comprobante de pago", text: `Hola ${name}, recibimos tu comprobante. Nuestro equipo lo revisará antes de activar tu cuenta.` };
  if (template === "advisor_assigned") return { subject: "Tu asesor de YuppiFacts", text: `Hola ${name}, tu asesor asignado es ${payload.advisorName || "nuestro equipo"}. Te contactará para continuar.` };
  return { subject: "Tu acceso a YuppiFacts está listo", text: `Hola ${name}, tu cuenta promocional ya está activa. Puedes ingresar a tu panel de trabajo.` };
}

export async function queuePromotionEmail(input:{voucherId?:string;recipient:string;template:Template;payload:Record<string,string>}) {
  const result = await query<{id:string}>(`INSERT INTO promotion_notification_outbox (voucher_id, recipient, reply_to, template, payload)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.voucherId ?? null, input.recipient, replyTo, input.template, JSON.stringify(input.payload)]);
  return result.rows[0].id;
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
    const sent = await client.send(new SendEmailCommand({ FromEmailAddress: fromEmail, ReplyToAddresses:[item.reply_to], Destination:{ToAddresses:[item.recipient]}, Content:{Simple:{Subject:{Data:content.subject,Charset:"UTF-8"},Body:{Text:{Data:content.text,Charset:"UTF-8"}}}} }));
    await query("UPDATE promotion_notification_outbox SET status='sent',provider_message_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[item.id,sent.MessageId ?? null]);
  } catch (error) {
    await query("UPDATE promotion_notification_outbox SET status='failed',last_error=$2 WHERE id=$1",[item.id,error instanceof Error ? error.message.slice(0,500) : "SES delivery failed"]);
  }
}
