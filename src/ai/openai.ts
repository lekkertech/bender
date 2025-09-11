import OpenAI from 'openai';

export type LoggerLike = {
  debug?: (obj?: any, msg?: string) => void;
  info?: (obj?: any, msg?: string) => void;
  error?: (obj?: any, msg?: string) => void;
};

export type ChatOpts = {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  logger?: LoggerLike;
  previousResponseId?: string;
  store?: boolean;
};

export class OpenAIClient {
  private client: OpenAI | null;
  private model: string;

  constructor(apiKey: string | undefined, model: string) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model = model;
  }

  enabled(): boolean {
    return !!this.client;
  }

  async chat(prompt: string, opts: ChatOpts = {}): Promise<{ text: string; id: string }> {
    if (!this.client) throw new Error('OpenAI not configured (missing OPENAI_API_KEY)');

    const system = opts.systemPrompt ?? 'You are a helpful Slack bot. Keep replies concise and suitable for Slack.';
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 256;

    const start = Date.now();

    try {
      // Single attempt using Responses API (no retries, no alternate parsing)
      const inputArr: any[] = [];
      if (system) inputArr.push({ role: 'system', content: system });
      inputArr.push({ role: 'user', content: prompt });

      const req: any = {
        model: this.model,
        input: inputArr,
      };

      if (opts.previousResponseId) {
        req.previous_response_id = opts.previousResponseId;
      }

      // Only non-gpt-5 models support max_output_tokens; omit for gpt-5 family
      if (!/^gpt-5/i.test(this.model)) {
        req.max_output_tokens = maxTokens;
      }
      // Disable reasoning for gpt-5 family; omit temperature for gpt-5
      if (/^gpt-5/i.test(this.model)) {
        req.reasoning = { effort: 'minimal' };
      } else if (opts.temperature !== undefined) {
        req.temperature = temperature;
      }

      // Persist so previous_response_id chains have retrievable state
      req.store = opts.store ?? true;

      const resp = await this.client.responses.create(req, { signal: opts.abortSignal });

      const took = Date.now() - start;
      opts.logger?.debug?.(
        { model: this.model, took_ms: took, usage: (resp as any)?.usage },
        'openai: responses call'
      );

      const txt = (resp as any)?.output_text?.trim();
      if (!txt) {
        throw new Error('OpenAI returned empty response');
      }
      return { text: txt, id: (resp as any)?.id };
    } catch (err) {
      // Log standard OpenAI error shape if present and rethrow
      try {
        const e: any = err;
        const details: any = {
          model: this.model,
          status: e?.status ?? e?.response?.status,
          requestID: e?.requestID ?? e?.response?.headers?.get?.('x-request-id'),
          code: e?.error?.code ?? e?.code,
          type: e?.error?.type ?? e?.type,
          param: e?.error?.param ?? e?.param,
          message: e?.error?.message ?? e?.message,
        };
        // Emit raw error details at debug level if logger provided
        opts.logger?.debug?.({ raw: e?.error || e }, 'openai: error raw');
        // Emit structured error
        if (opts.logger?.error) {
          opts.logger.error(details, 'OpenAI API error');
        } else {
          console.error('OpenAI API error', details);
        }
      } catch {}
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}