import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { ModelWiringHook } from './types';

const PROVIDER_NAME = 'diiisco';

/**
 * Unlike Codex, `~/.hermes/config.yaml` is not fully owned by DIIISCO — it
 * holds the user's other settings, so this is a genuine read-modify-write.
 * Parsed with `yaml`'s `Document` API rather than a plain `parse`/`stringify`
 * round trip specifically because it preserves the rest of the file's
 * comments and formatting on write-back — a plain YAML library would lose
 * them, silently discarding anything the user hand-edited elsewhere in the
 * file.
 */
export const hermesModelWiring: ModelWiringHook = async ({ model, endpoint, key }) => {
  const hermesDir = join(homedir(), '.hermes');
  mkdirSync(hermesDir, { recursive: true });
  const configPath = join(hermesDir, 'config.yaml');

  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const doc = parseDocument(existing);

  doc.setIn(['providers', PROVIDER_NAME], {
    name: 'DIIISCO',
    api: `${endpoint.replace(/\/$/, '')}/v1`,
    api_key: key,
    transport: 'chat_completions',
    default_model: model,
  });
  doc.setIn(['model', 'provider'], `custom:${PROVIDER_NAME}`);
  doc.setIn(['model', 'default'], model);

  if (existing !== '') copyFileSync(configPath, `${configPath}.bak`);
  writeFileSync(configPath, doc.toString(), 'utf8');

  return {};
};
