import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { createAccountInput, verifyOtpInput } from '../src/contracting.js';
import { completeLoginInput, changePinInput } from '../src/access.js';
import { createPromotionContractInput } from '../src/promotionContracts.js';
import { promotionPlanOrderInput } from '../src/promotionPlans.js';
import { hashSecret, verifySecret, randomOtp, randomToken } from '../src/security.js';
import { encryptCredential, decryptCredential } from '../src/credentials.js';

let checks = 0;
function check(value: unknown) { assert.ok(value); checks++; }
const uuid = 'a30f9d8c-b390-4422-87de-6fda75c1735f';
const account = {fullName:' Claudia Prueba ',email:'PRUEBA@example.com',pin:'1234',pinConfirmation:'1234'};
const normalized = createAccountInput.parse(account);
check(normalized.email === 'prueba@example.com' && normalized.fullName === 'Claudia Prueba');
check(!createAccountInput.safeParse({...account,pinConfirmation:'4321'}).success);
check(!createAccountInput.safeParse({...account,pin:'12345',pinConfirmation:'12345'}).success);
check(verifyOtpInput.safeParse({challengeId:uuid,code:'1234'}).success);
check(!verifyOtpInput.safeParse({challengeId:uuid,code:'123'}).success);
check(completeLoginInput.safeParse({challengeId:uuid,verificationToken:'a'.repeat(43),pin:'1234'}).success);
check(!completeLoginInput.safeParse({challengeId:uuid,verificationToken:'short',pin:'1234'}).success);
check(!changePinInput.safeParse({currentPin:'1234',pin:'2222',pinConfirmation:'3333'}).success);
for (const billingPeriod of ['monthly','quarterly','semiannual','annual']) {
  check(createPromotionContractInput.safeParse({profile:'accountant',planId:'independent_accountant',billingPeriod,phoneE164:'+525500000000',countryCode:'MX',fullName:'Persona Prueba',email:'prueba@example.com'}).success);
}
check(!promotionPlanOrderInput.safeParse({ids:Array(101).fill('independent_accountant')}).success);
check(promotionPlanOrderInput.safeParse({ids:['independent_accountant']}).success);
const hashed = await hashSecret('1234');
check(await verifySecret('1234', hashed));
check(!(await verifySecret('4321', hashed)));
check(/^\d{4}$/.test(randomOtp()));
check(randomToken().length >= 32);
process.env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY = 'local-audit-fixture-not-a-real-secret';
const encrypted = encryptCredential('local-payment-fixture');
check(decryptCredential(encrypted) === 'local-payment-fixture');
assert.throws(()=>decryptCredential(encrypted.slice(0,-2)+'!!')); checks++;

// Isolated parser: no production server, DB, payment or email connections.
const app = express();
app.use(express.json({limit:'1mb'}));
app.post('/echo',(req,res)=>res.json(req.body));
app.get('/health',(_req,res)=>res.json({ok:true}));
app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status || 500).json({error:'invalid'}));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve=>server.once('listening',resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
try {
  const plain = await fetch(url+'/echo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:'1234'})});
  check(plain.status === 200 && (await plain.json()).pin === '1234');
  const valid = gzipSync(Buffer.from('{"ok":true}'));
  const compressed = await fetch(url+'/echo',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:valid});
  check(compressed.status === 200 && (await compressed.json()).ok === true);
  const malformed = Buffer.concat([valid,Buffer.from([0x1f,0x00,0xff])]);
  await fetch(url+'/echo',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:malformed}).catch(()=>null);
  await new Promise(resolve=>setTimeout(resolve,100));
  check((await fetch(url+'/health')).status === 200);
  const oversized = await fetch(url+'/echo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data:'x'.repeat(1024*1024)})});
  check(oversized.status === 413);
} finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
console.log(`${checks} checks passed; Node ${process.version}; no external services contacted`);
