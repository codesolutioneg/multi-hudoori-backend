import { config } from '../config';
import { AppError } from '../utils/errors';
import { ASSISTANT_SYSTEM_PROMPT } from './assistant.knowledge';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type GeminiPart = { text: string };
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string; status?: string; code?: number };
};

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

function modelChain(): string[] {
  const primary = config.gemini.model;
  return [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
}

function toGeminiHistory(messages: ChatMessage[]): GeminiContent[] {
  return messages.slice(-16).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number, message: string): boolean {
  if (status === 429 || status === 503 || status === 500) return true;
  const m = message.toLowerCase();
  return (
    m.includes('high demand') ||
    m.includes('overloaded') ||
    m.includes('resource exhausted') ||
    m.includes('unavailable') ||
    m.includes('try again')
  );
}

function friendlyGeminiError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('high demand') || m.includes('overloaded') || m.includes('try again later')) {
    return 'الخدمة مشغولة حالياً. يُرجى المحاولة بعد قليل.';
  }
  if (m.includes('quota') || m.includes('resource exhausted') || m.includes('exceeded')) {
    return 'حصة خدمة الذكاء الاصطناعي ممتلئة مؤقتاً. يُرجى المحاولة لاحقاً.';
  }
  if (m.includes('api key') || m.includes('permission')) {
    return 'المساعد غير مضبوط بشكل صحيح. يُرجى التواصل مع مسؤول المنصة.';
  }
  return 'تعذّر إعداد الإجابة. يُرجى إعادة المحاولة أو اختصار السؤال.';
}

export function buildAssistantUserTurn(message: string, page?: string): string {
  const trimmed = message.trim();
  const route = page?.trim();
  if (!route) return trimmed;
  return `الصفحة الحالية: ${route}\n\n${trimmed}`;
}

async function callGemini(
  model: string,
  apiKey: string,
  contents: GeminiContent[],
): Promise<{ ok: true; reply: string } | { ok: false; status: number; message: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: ASSISTANT_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 2048,
    },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    return { ok: false, status: 0, message: 'network error' };
  }

  const payload = (await res.json()) as GeminiResponse;
  const errMsg = payload.error?.message ?? res.statusText;
  if (!res.ok) {
    return { ok: false, status: res.status, message: errMsg };
  }

  const reply =
    payload.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim() ?? '';
  if (!reply) {
    return { ok: false, status: 502, message: 'empty response' };
  }
  return { ok: true, reply };
}

export async function chatWithAssistant(input: {
  message: string;
  history?: ChatMessage[];
  page?: string;
}): Promise<{ reply: string }> {
  const trimmed = input.message.trim();
  if (!trimmed) throw new AppError('يرجى كتابة سؤال', 400, 'VALIDATION');
  if (trimmed.length > 2000) throw new AppError('السؤال طويل جداً', 400, 'VALIDATION');

  const apiKey = config.gemini.apiKey;
  if (!apiKey) {
    throw new AppError('المساعد غير مفعّل حالياً. يُرجى التواصل مع المسؤول.', 503, 'ASSISTANT_DISABLED');
  }

  const contents: GeminiContent[] = [
    ...toGeminiHistory(input.history ?? []),
    { role: 'user', parts: [{ text: buildAssistantUserTurn(trimmed, input.page) }] },
  ];

  const models = modelChain();
  const retryDelays = [0, 1500, 3000];
  let lastMessage = '';

  for (const model of models) {
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (retryDelays[attempt]! > 0) await sleep(retryDelays[attempt]!);
      const result = await callGemini(model, apiKey, contents);
      if (result.ok) return { reply: result.reply };
      lastMessage = result.message;
      if (!isRetryable(result.status, result.message)) break;
    }
  }

  throw new AppError(friendlyGeminiError(lastMessage), 502, 'ASSISTANT_UNAVAILABLE');
}
