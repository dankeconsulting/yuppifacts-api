// Local fixtures only. Test processes never use an inherited production service.
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/fixture';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIAFIXTURE0000000000';
process.env.AWS_SECRET_ACCESS_KEY = 'fixture-only-not-a-real-aws-secret';
process.env.AWS_SESSION_TOKEN = '';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.AWS_S3_BUCKET = 'yuppifacts-local-test-fixture';
process.env.AWS_SES_FROM_EMAIL = 'no-reply@example.com';
process.env.WEB_ORIGIN = 'https://web.example.com';
process.env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY = 'fixture-only-payment-encryption';
