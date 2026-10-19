import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z, ZodError } from "zod";
import { ApiError, createAccount, createAccountInput, createContractingSession, createSessionInput, issueOtp, issueOtpInput, listPlans, verifyOtp, verifyOtpInput } from "./contracting.js";
import { createUploadUrl } from "./storage.js";
import { bootstrapInput, bootstrapStatus, claimMasterAdministrator } from "./bootstrap.js";

const origins = (process.env.WEB_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (process.env.APP_ENV === "production" && origins.length === 0) throw new Error("WEB_ORIGIN is required in production");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(new ApiError(403, "Origen no autorizado."));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH"],
  allowedHeaders: ["content-type", "x-contracting-token", "x-admin-pin"],
}));
app.use(express.json({ limit: "1mb" }));

const contractingLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false });
const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });

function accessToken(request: Request) {
  const token = request.get("x-contracting-token");
  if (!token || token.length < 32) throw new ApiError(401, "Sesión de contratación no válida.");
  return token;
}

app.get("/health", (_request, response) => response.json({ status: "ok", service: "yuppifacts-api" }));
app.get("/v1/bootstrap/status", async (_request, response, next) => {
  try { response.json(await bootstrapStatus()); } catch (error) { next(error); }
});
app.post("/v1/bootstrap/master-administrator", otpLimiter, async (request, response, next) => {
  try { response.status(201).json(await claimMasterAdministrator(bootstrapInput.parse(request.body))); } catch (error) { next(error); }
});
app.get("/v1/plans", async (_request, response, next) => {
  try { response.json({ plans: await listPlans() }); } catch (error) { next(error); }
});
app.post("/v1/contracting/sessions", contractingLimiter, async (request, response, next) => {
  try { response.status(201).json(await createContractingSession(createSessionInput.parse(request.body))); } catch (error) { next(error); }
});
app.post("/v1/contracting/sessions/:id/otp", otpLimiter, async (request, response, next) => {
  try { response.status(201).json(await issueOtp(String(request.params.id), accessToken(request), issueOtpInput.parse(request.body))); } catch (error) { next(error); }
});
app.post("/v1/contracting/sessions/:id/otp/verify", otpLimiter, async (request, response, next) => {
  try { response.json(await verifyOtp(String(request.params.id), accessToken(request), verifyOtpInput.parse(request.body))); } catch (error) { next(error); }
});
app.post("/v1/contracting/sessions/:id/account", contractingLimiter, async (request, response, next) => {
  try { response.status(201).json(await createAccount(String(request.params.id), accessToken(request), createAccountInput.parse(request.body))); } catch (error) { next(error); }
});

const uploadInput = z.object({ taxpayerId: z.string().uuid(), filename: z.string().min(1).max(180), contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]) });
app.post("/v1/documents/upload-url", async (request, response, next) => {
  try { response.status(201).json(await createUploadUrl(uploadInput.parse(request.body))); } catch (error) { next(error); }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ApiError) return response.status(error.status).json({ error: error.message });
  if (error instanceof ZodError) return response.status(400).json({ error: "Datos inválidos", details: error.flatten() });
  console.error(error);
  return response.status(500).json({ error: "Error interno" });
});

const port = Number(process.env.PORT ?? 10000);
app.listen(port, () => console.info(`YuppiFacts API ready on ${port}`));
