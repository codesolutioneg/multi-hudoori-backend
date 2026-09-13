/**
 * List emp_code values from the BioTime server (not limited to Hudoori profiles).
 */
import { BioTimeConnector } from './biotime/biotimeConnector.service';

/** Paginate BioTime employees and collect unique emp_code values. */
export async function listAllBiotimeEmpCodes(): Promise<string[]> {
  const connector = await BioTimeConnector.fromDb();
  const codes = new Set<string>();
  let page = 1;

  while (page <= 200) {
    const response = await connector.getEmployees(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const code = String(row.emp_code ?? '').trim();
      if (code) codes.add(code);
    }
    const total = response.count ?? 0;
    if (total > 0 && page * 200 >= total) break;
    if (rows.length < 200) break;
    page += 1;
  }

  return [...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
