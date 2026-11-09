import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/index.js';
import { clearChat, getChat, postAnswer, postMessage } from '../handlers/assistant.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { resolveProjectIds } from '../middlewares/project-scope.js';
import { requireSession } from '../middlewares/require-session.js';
import { validateBody } from '../middlewares/validate.js';
import { answerSchema, messageSchema } from '../schemas/assistant.schemas.js';

/** The assistant: session-scoped like the threshold routes, and rate limited per account because each answer costs CPU. */
export const assistantRouter = Router();

const scope = [asyncHandler(requireSession), asyncHandler(resolveProjectIds)];

const perAccount = rateLimit({
  windowMs: 60_000,
  limit: config.llm.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? 'anonymous',
  validate: { keyGeneratorIpFallback: false },
});

assistantRouter.get('/api/v1/assistant', ...scope, asyncHandler(getChat));
assistantRouter.post(
  '/api/v1/assistant',
  ...scope,
  perAccount,
  express.json({ limit: '16kb' }),
  validateBody(messageSchema),
  asyncHandler(postMessage),
);
assistantRouter.post(
  '/api/v1/assistant/messages/:messageId/actions/:index',
  ...scope,
  express.json({ limit: '2kb' }),
  validateBody(answerSchema),
  asyncHandler(postAnswer),
);
assistantRouter.delete('/api/v1/assistant', ...scope, asyncHandler(clearChat));
