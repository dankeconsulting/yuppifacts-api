import assert from 'node:assert/strict';
import { test, afterEach, mock } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { db } from '../src/db.js';
import { createAccountInput, createContractingSession, createSessionInput } from '../src/contracting.js';
import { completeLogin, completeLoginInput, verifyLoginCode } from '../src/access.js';
import { createCheckout } from '../src/mercado-pago.js';
import { encryptCredential } from '../src/credentials.js';
import { hashOpaqueToken, hashSecret, verifySecret } from '../src/security.js';
import { deliverPromotionEmail } from '../src/promotionNotifications.js';
import { createPromotionVoucher, createPromotionVoucherInput } from '../src/promotionVouchers.js';
import { promotionPlanCreateInput } from '../src/promotionPlans.js';
import { campaignCreateInput } from '../src/promotionCampaigns.js';
import { deleteSubscribersInput } from '../src/adminSubscribers.js';

const id = 'a30f9d8c-b390-4422-87de-6fda75c1735f';
const userId = 'd936b4fb-6496-4e16-8e54-277c8b895852';
const accessToken = 'fixture-access-token-with-at-least-32-characters';
const result = (rows: any[] = []) => ({rows,rowCount:rows.length});
type Call = {sql:string;values:any[]};
function database(handler:(sql:string,values:any[])=>any) {
  const calls:Call[] = [];
  const query = async (sql:string,values:any[] = []) => {
    calls.push({sql,values});
    if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return result();
    return handler(sql,values);
  };
  mock.method(db,'query',query as any);
  mock.method(db,'connect',(async()=>({query,release(){}})) as any);
  return calls;
}
afterEach(()=>mock.restoreAll());

test('registration, vouchers and plan validation preserve valid data and boundaries',()=>{
  const account = {fullName:' Claudia Prueba ',email:'Prueba+tag@example.com',pin:'1234',pinConfirmation:'1234'};
  assert.deepEqual(createAccountInput.parse(account),{...account,fullName:'Claudia Prueba',email:'prueba+tag@example.com'});
  for (const pin of ['','123','12345','abcd']) assert.equal(createAccountInput.safeParse({...account,pin,pinConfirmation:pin}).success,false);
  for (const email of ['no-at-sign','a@@example.com','a..b@example.com']) assert.equal(createAccountInput.safeParse({...account,email}).success,false);
  const invalid = createAccountInput.safeParse({...account,pinConfirmation:'4321'});
  assert.equal(invalid.success,false);
  if (!invalid.success) assert.ok(invalid.error.flatten().fieldErrors.pinConfirmation);
  const plan = {id:'independent_accountant',mode:'independent_accountant',billingPeriods:['monthly','quarterly','semiannual','annual'],name:'Fixture plan',seats:'1',monthlyAmountCents:59900,quarterlyAmountCents:161730,semiannualAmountCents:305490,annualAmountCents:575040,regularMonthlyAmountCents:null,benefits:['Fixture benefit'],active:true,displayOrder:1};
  assert.equal(promotionPlanCreateInput.safeParse(plan).success,true);
  assert.equal(promotionPlanCreateInput.safeParse({...plan,billingPeriods:['monthly','monthly']}).success,false);
  assert.equal(promotionPlanCreateInput.safeParse({...plan,benefits:Array(51).fill('Fixture benefit')}).success,false);
  assert.equal(promotionPlanCreateInput.safeParse({...plan,benefits:['x'.repeat(2001)]}).success,false);
  assert.equal(promotionPlanCreateInput.safeParse({...plan,monthlyAmountCents:1.5}).success,false);
  const campaign = campaignCreateInput.parse({name:'Fixture campaign',capacity:100,durationUnit:'days',durationValue:7,startsAt:'2026-10-25T00:00:00Z'});
  assert.equal(campaign.isActive,true); assert.deepEqual(campaign.planIds,[]);
  assert.deepEqual(deleteSubscribersInput.parse({ids:[id],confirmationIds:['42']}),{ids:[id],confirmationIds:[42]});
  assert.equal(deleteSubscribersInput.safeParse({ids:Array(101).fill(id),confirmationIds:[42]}).success,false);
});

test('new contracting sessions preserve price, currency and hashed access tokens',async()=>{
  const plan = {id:'individual',name:'Fixture',audience_copy:'Fixture',organization_kind:'individual',monthly_amount_cents:59900,currency:'MXN',display_order:1};
  const calls=database((sql,v)=>{
    if(sql.includes('FROM subscription_plans'))return result([plan]);
    if(sql.includes('INSERT INTO contracting_sessions'))return result([{id,folio:v[0],plan_id:v[1],billing_period:v[2],quoted_amount_cents:v[3],currency:v[4],lifecycle_status:'phone_pending',phone_e164:null,expires_at:new Date('2027-01-01T00:00:00Z')}]);
    throw new Error('Unexpected query in session fixture');
  });
  for(const [billingPeriod,expected]of [['monthly',59900],['quarterly',161730],['annual',575040]] as const){
    const response=await createContractingSession(createSessionInput.parse({planId:'individual',billingPeriod}));
    assert.equal(response.session.quotedAmountCents,expected);
    assert.equal(response.session.currency,'MXN');
    assert.equal(response.session.lifecycleStatus,'phone_pending');
    const inserted=calls.filter(c=>c.sql.includes('INSERT INTO contracting_sessions')).at(-1)!;
    assert.equal(inserted.values[5],hashOpaqueToken(response.accessToken));
    assert.notEqual(inserted.values[5],response.accessToken);
  }
});

test('checkout uses the quoted amount and sandbox URL without activating the account',async()=>{
  const session={id,folio:'YF-FIXTURE',plan_id:'individual',billing_period:'quarterly',quoted_amount_cents:161730,currency:'MXN',lifecycle_status:'pending_payment',access_token_hash:hashOpaqueToken(accessToken)};
  const calls=database(sql=>{
    if(sql.includes('FROM contracting_sessions'))return result([session]);
    if(sql.includes('SELECT 1 FROM payment_attempts'))return result();
    if(sql.includes('FROM payment_provider_configurations'))return result([{environment:'sandbox',access_token_encrypted:encryptCredential('fixture-mp-token')}]);
    if(sql.includes('FROM subscription_plans'))return result([{name:'Fixture'}]);
    if(/^(INSERT INTO payment_attempts|UPDATE contracting_sessions|INSERT INTO contracting_audit_events)/.test(sql))return result();
    throw new Error('Unexpected query in checkout fixture');
  });
  let payload:any;
  mock.method(globalThis,'fetch',async(url:any,options:any)=>{
    assert.equal(url,'https://api.mercadopago.com/checkout/preferences');
    payload=JSON.parse(options.body);
    return new Response(JSON.stringify({id:'fixture-preference',sandbox_init_point:'https://sandbox.example.com/pay',init_point:'https://production.example.com/pay'}),{status:200});
  });
  const checkout=await createCheckout(id,accessToken);
  assert.equal(checkout.checkoutUrl,'https://sandbox.example.com/pay');
  assert.equal(payload.items[0].unit_price,1617.30);
  assert.equal(payload.items[0].currency_id,'MXN');
  assert.equal(payload.external_reference,'YF-FIXTURE');
  assert.equal(payload.back_urls.success,'https://web.example.com/registro/YF-FIXTURE?payment=success');
  assert.ok(calls.some(c=>c.sql.includes('INSERT INTO payment_attempts')&&c.values[2]===161730));
  assert.ok(!calls.some(c=>/UPDATE users/.test(c.sql)));
  session.access_token_hash=hashOpaqueToken('different-token');
  await assert.rejects(()=>createCheckout(id,accessToken),{status:404});
});

test('checkout provider failure creates no payment attempt or status update',async()=>{
  const calls=database(sql=>{
    if(sql.includes('FROM contracting_sessions'))return result([{id,folio:'YF-FIXTURE',plan_id:'individual',billing_period:'monthly',quoted_amount_cents:59900,currency:'MXN',lifecycle_status:'pending_payment',access_token_hash:hashOpaqueToken(accessToken)}]);
    if(sql.includes('SELECT 1 FROM payment_attempts'))return result();
    if(sql.includes('FROM payment_provider_configurations'))return result([{environment:'sandbox',access_token_encrypted:encryptCredential('fixture-mp-token')}]);
    if(sql.includes('FROM subscription_plans'))return result([{name:'Fixture'}]);
    throw new Error('Unexpected write after failed checkout');
  });
  mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({message:'fixture rejection'}),{status:400}));
  await assert.rejects(()=>createCheckout(id,accessToken),{status:502});
  assert.ok(!calls.some(c=>/INSERT|UPDATE/.test(c.sql)));
});

test('login preserves OTP expiry, PIN rejection and session token hashing',async()=>{
  const challenge:any={id,user_id:userId,expires_at:new Date(Date.now()+60000),attempts:0,max_attempts:5,verified_at:new Date(),completed_at:null,invalidated_at:null,verification_token_hash:hashOpaqueToken(accessToken),code_hash:await hashSecret('1234')};
  const user={id:userId,full_name:'Fixture User',username:null,phone_e164:'+525500000000',pin_hash:await hashSecret('1234'),platform_role:'subscriber',account_status:'active',is_online:true};
  const calls=database(sql=>{
    if(sql.includes('FROM access_challenges'))return result([challenge]);
    if(sql.includes('FROM users'))return result([user]);
    if(sql.includes('INSERT INTO application_sessions'))return result([{expires_at:new Date(Date.now()+12*60*60*1000)}]);
    if(sql.includes('INSERT INTO subscriber_activity_log'))return result();
    if(sql.startsWith('UPDATE access_challenges')||sql.startsWith('UPDATE users'))return result();
    throw new Error('Unexpected query in login fixture');
  });
  const input=completeLoginInput.parse({challengeId:id,verificationToken:accessToken,pin:'4321'});
  await assert.rejects(()=>completeLogin(input,{ipHash:null,userAgent:'fixture'}),{status:401});
  assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO application_sessions')));
  const response=await completeLogin({...input,pin:'1234'},{ipHash:null,userAgent:'fixture'});
  const session=calls.find(c=>c.sql.includes('INSERT INTO application_sessions'))!;
  assert.equal(session.values[1],hashOpaqueToken(response.accessToken));
  assert.equal(response.account.role,'subscriber');
  challenge.verified_at=null;challenge.expires_at=new Date(Date.now()-1000);
  await assert.rejects(()=>verifyLoginCode({challengeId:id,code:'1234'}),{status:400});
});

test('voucher signing and persistence retain the contract, user and amount',async()=>{
  const calls=database((sql,v)=>{
    if(sql.includes('FROM promotion_contracts')&&sql.includes('access_token_hash'))return result([{id,folio:'YFP-FIXTURE',plan_id:'independent_accountant',billing_period:'monthly',quoted_amount_cents:61997,currency:'MXN',lifecycle_status:'checkout_started'}]);
    if(sql.includes('SELECT voucher.id'))return result();
    if(sql.includes('FROM users'))return result([{id:userId,platform_role:'subscriber'}]);
    if(sql.includes('SELECT user_id FROM promotion_contracts'))return result([{user_id:userId}]);
    if(sql.startsWith('UPDATE users')||sql.startsWith('UPDATE promotion_contracts')||sql.includes('INSERT INTO promotion_vouchers'))return result();
    throw new Error('Unexpected query in voucher fixture');
  });
  const input=createPromotionVoucherInput.parse({fullName:'Fixture User',email:'VOUCHER@example.com',phoneE164:'+525500000000',countryCode:'MX',stateName:'Ciudad de México',cityName:'Fixture City',pin:'1234',pinConfirmation:'1234',filename:'voucher prueba.pdf',contentType:'application/pdf',byteSize:123,sha256:'a'.repeat(64),promotionId:id,promotionToken:accessToken});
  const response=await createPromotionVoucher(input);
  const upload=new URL(response.uploadUrl);
  assert.equal(upload.searchParams.get('X-Amz-Expires'),'300');
  assert.ok(upload.pathname.endsWith('/voucher_prueba.pdf'));
  assert.equal(response.expiresIn,300);
  const inserted=calls.find(c=>c.sql.includes('INSERT INTO promotion_vouchers'))!;
  assert.equal(inserted.values[0],response.voucherId);
  assert.equal(inserted.values[1],id);
  assert.equal(inserted.values[3],'voucher@example.com');
  assert.equal(inserted.values[8],61997);
  const update=calls.find(c=>c.sql.startsWith('UPDATE users'))!;
  assert.equal(update.values[0],userId);
  assert.ok(await verifySecret('1234',update.values[3]));
});

for(const fail of [false,true])test(`SES ${fail?'failure remains retryable':'success stores message id and escapes content'}`,async()=>{
  const calls=database(sql=>{
    if(sql.startsWith('UPDATE promotion_notification_outbox SET status=\'sending\''))return result([{id,recipient:'recipient@example.com',reply_to:'reply@example.com',template:'contract_received',payload:{fullName:'<script>fixture</script>'},attempts:1}]);
    if(sql.startsWith('UPDATE promotion_notification_outbox SET status='))return result();
    throw new Error('Unexpected query in email fixture');
  });
  mock.method(SESv2Client.prototype,'send',(async(command:any)=>{
    assert.equal(command.input.Destination.ToAddresses[0],'recipient@example.com');
    assert.ok(!command.input.Content.Simple.Body.Html.Data.includes('<script>'));
    if(fail)throw new Error('fixture transient provider error');
    return {MessageId:'fixture-message-id'};
  }) as any);
  await deliverPromotionEmail(id);
  const updated=calls.at(-1)!;
  assert.ok(updated.sql.includes(fail?"status='failed'":"status='sent'"));
  assert.equal(updated.values[1],fail?'fixture transient provider error':'fixture-message-id');
});
