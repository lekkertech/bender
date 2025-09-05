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
        // Primary: Responses API (omit temperature for models that don't support it, e.g., gpt-5)
        const req: any = {
          model: this.model,
          max_output_tokens: maxTokens,
          input: `${system}\n\n${prompt}`,
        };
        if (opts.temperature !== undefined && !/^gpt-5/i.test(this.model)) {
          req.temperature = temperature;
        }
        const resp = await this.client.responses.create(req, { signal: opts.abortSignal });
 
        // Robust parsing across possible shapes
        let txt: string | undefined =
          (resp as any)?.output_text?.trim();
 
        if (!txt && Array.isArray((resp as any)?.output)) {
          try {
            txt = (resp as any).output
              .map((o: any) =>
                Array.isArray(o?.content)
                  ? o.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
                  : ''
              )
              .join('')
              .trim();
          } catch {}
        }
 
        // Some SDK versions expose data[].content[].text
        if (!txt && Array.isArray((resp as any)?.data)) {
          try {
            const arr = (resp as any).data;
            const parts = arr
              .map((d: any) =>
                Array.isArray(d?.content)
                  ? d.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
                  : ''
              )
              .join('');
            txt = parts.trim() || undefined;
          } catch {}
        }
 
        const took = Date.now() - start;
        if (process.env.LOG_LEVEL === 'debug') {
          console.debug('OpenAI Responses call', { model: this.model, took_ms: took, attempt, usage: (resp as any)?.usage, parsed_len: txt?.length ?? 0 });
        }
        if (txt && txt.trim()) {
          return txt.trim();
        }
 
        // Fallback: Chat Completions API
        if (process.env.LOG_LEVEL === 'debug') {
          console.debug('OpenAI fallback to chat.completions due to empty Responses output', { model: this.model, attempt });
        }
        const compReq: any = {
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
        };
        if (opts.temperature !== undefined && !/^gpt-5/i.test(this.model)) {
          compReq.temperature = temperature;
        }
        const cmpl = await this.client.chat.completions.create(compReq);
        const ctext =
          (cmpl as any)?.choices?.[0]?.message?.content?.trim() ??
          (Array.isArray((cmpl as any)?.choices)
            ? (cmpl as any).choices
                .map((ch: any) => ch?.message?.content ?? '')
                .join('')
                .trim()
            : undefined);
 
        if (ctext && ctext.trim()) {
          return ctext.trim();
        }
 
        throw new Error('OpenAI returned empty response');
      } catch (err) {
        lastErr = err;
        // brief backoff
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}