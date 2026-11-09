import type { Request, Response } from 'express';
import { assistantService } from '../services/assistant-service.js';

export async function getChat(req: Request, res: Response): Promise<void> {
  const [status, messages] = await Promise.all([
    assistantService.status(),
    assistantService.history(req.userId!),
  ]);
  res.status(200).json({ ...status, messages });
}

export async function postMessage(req: Request, res: Response): Promise<void> {
  const body = req.body as { message: string };
  const message = await assistantService.turn(req.userId!, req.projectIds ?? [], body.message);
  res.status(200).json({ message });
}

export async function postAnswer(req: Request, res: Response): Promise<void> {
  const body = req.body as { decision: 'confirm' | 'decline' };
  const action = await assistantService.answer(
    req.userId!,
    req.projectIds ?? [],
    Number(req.params.messageId),
    Number(req.params.index),
    body.decision,
  );
  res.status(200).json({ action });
}

export async function clearChat(req: Request, res: Response): Promise<void> {
  await assistantService.clear(req.userId!);
  res.status(204).end();
}
