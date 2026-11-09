import { z } from 'zod';

export const messageSchema = z.object({ message: z.string().trim().min(1).max(1000) }).strict();
export const answerSchema = z.object({ decision: z.enum(['confirm', 'decline']) }).strict();
