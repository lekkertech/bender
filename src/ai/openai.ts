import OpenAI from 'openai';

export type ChatOpts = {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
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

  async chat(prompt: string, opts: ChatOpts = {}): Promise<string> {
    if (!this.client) throw new Error('OpenAI not configured (missing OPENAI_API_KEY)');

    const system = opts.systemPrompt ?? 'You are a helpful Slack bot. Keep replies concise and suitable for Slack.';
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 256;

    const start = Date.now();
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Build request payload; omit temperature for models that don't support it (e.g., gpt-5)
        const req: any = {
          model: this.model,
          max_output_tokens: maxTokens,
          // Use Responses API. We inline the system instruction with the user prompt to avoid relying on
          // optional typed fields that might vary across SDK versions.
          input: `${system}\n\n${prompt}`,
        };
        if (opts.temperature !== undefined && !/^gpt-5/i.test(this.model)) {
          req.temperature = temperature;
        }
        const resp = await this.client.responses.create(req, { signal: opts.abortSignal });

        // Prefer SDK helper, with robust fallback parsing for various response shapes
        const txt =
          (resp as any)?.output_text?.trim() ??
          (Array.isArray((resp as any)?.output)
            ? (resp as any).output
                .map((o: any) =>
                  Array.isArray(o?.content)
                    ? o.content.map((c: any) => c?.text ?? '').join('')
                    : ''
                )
                .join('')
                .trim()
            : undefined);

        const took = Date.now() - start;
        // Lightweight logging; callers can add more structured logs if desired.
        if (process.env.LOG_LEVEL === 'debug') {
          console.debug('OpenAI chat call', { model: this.model, took_ms: took, attempt, usage: (resp as any)?.usage });
        }
        if (!txt) throw new Error('OpenAI returned empty response');
        return txt;
      } catch (err) {
        lastErr = err;
        // brief backoff
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}