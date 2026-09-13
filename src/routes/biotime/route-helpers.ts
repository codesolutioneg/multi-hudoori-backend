import { ensureBioTimeConfigFromEnv } from '../../bootstrap/biotimeConfig';
import { requireCompanyId } from '../../tenant/context';

export function p(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

/** Parse JSON-RPC booleans safely (Boolean("false") would be true in JS). */
export function parseRpcBool(value: unknown): boolean {
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  return Boolean(value);
}

/** BioTime/HR config for the active company only. */
export async function getConfig() {
  return ensureBioTimeConfigFromEnv(requireCompanyId());
}
