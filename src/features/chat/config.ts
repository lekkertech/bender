import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { ChatConfigFile, ChatDefaultConfig, PromptRecord } from './types.js';

/**
 * Load full chat config (default + history).
 */
export function loadChatConfig(fp: string | undefined): ChatConfigFile | null {
  try {
    if (!fp) return null;
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as ChatConfigFile;
    const def = parsed?.default ?? parsed?.defaultChat;
    const hist = Array.isArray(parsed?.promptHistory) ? parsed!.promptHistory! : [];
    return { default: def, promptHistory: hist };
  } catch {
    return null;
  }
}

/**
 * Atomically write JSON to disk by writing to a temp file and renaming.
 */
export function writeJsonAtomic(fp: string, obj: any): void {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, fp);
}

/**
 * Update the top-level default systemPrompt on disk and append a history record.
 * Keeps only the last 10 history entries. Returns updated default + history.
 */
export function updateDefaultPromptOnDisk(
  fp: string,
  newPrompt: string,
  setter: { id: string; name?: string }
): { defaultChat: ChatDefaultConfig; promptHistory: PromptRecord[] } {
  const current = loadChatConfig(fp) || { default: {}, promptHistory: [] };
  const updatedDefault: ChatDefaultConfig = { ...(current.default || {}), systemPrompt: newPrompt };

  const rec: PromptRecord = {
    text: newPrompt,
    setById: setter.id,
    setByName: setter.name,
    ts: new Date().toISOString(),
  };
  const history = [rec, ...(current.promptHistory || [])].slice(0, 10);

  const out: any = {};
  if (
    updatedDefault &&
    (updatedDefault.systemPrompt != null ||
      updatedDefault.temperature != null ||
      updatedDefault.maxTokens != null)
  ) {
    out.default = updatedDefault;
  }
  out.promptHistory = history;

  writeJsonAtomic(fp, out);
  return { defaultChat: updatedDefault, promptHistory: history };
}