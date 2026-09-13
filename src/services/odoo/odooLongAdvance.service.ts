/**
 * Push an activated Hudoori long advance to Odoo, then create its draft
 * accounting move through biotime.advance.long.accounts.send.
 */
import { AdvanceState } from '@prisma/client';
import { prisma } from '../../prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { getOdooConfig } from './odooClient.service';
import { authenticateOdooOrm, executeKw, searchRead } from './odooOrm.service';

const KW_CTX = { context: { tracking_disable: true, mail_notrack: true } };
const MARKER_PREFIX = 'Hudoori-Advance-ID:';

type LongAdvanceForOdoo = Awaited<ReturnType<typeof loadLongAdvance>>;
type OdooSession = Awaited<ReturnType<typeof authenticateOdooOrm>>;

export type OdooLongAdvanceResult = {
  advanceLongId: number;
  accountsSendId: number;
  moveId: number;
  moveName: string;
  sendReference: string;
};

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function longAdvanceOdooMarker(localId: string): string {
  return `${MARKER_PREFIX}${localId}`;
}

export function buildOdooLongAdvanceNote(
  localId: string,
  notes?: string | null,
): string {
  const marker = longAdvanceOdooMarker(localId);
  const clean = notes?.trim();
  return clean ? `${clean}\n${marker}` : marker;
}

export function buildOdooLongAdvanceVals(
  advance: {
    id: string;
    totalAmount: number;
    installments: number;
    startDate: Date | null;
    date: Date;
    nextDeductionDate: Date | null;
    notes: string | null;
  },
  employeeId: number,
): Record<string, unknown> {
  const start = advance.startDate ?? advance.date;
  return {
    employee_id: employeeId,
    total_amount: advance.totalAmount,
    installments: advance.installments,
    start_date: isoDate(start),
    next_deduction_date: isoDate(advance.nextDeductionDate ?? start),
    note: buildOdooLongAdvanceNote(advance.id, advance.notes),
    // The Odoo advance and account.move both remain Draft for finance review.
    state: 'draft',
  };
}

async function loadLongAdvance(advanceId: string) {
  const advance = await prisma.advanceLong.findUnique({
    where: { id: advanceId },
    include: {
      employee: { select: { code: true, name: true } },
      payments: true,
    },
  });
  if (!advance) throw new NotFoundError('السلفة الطويلة غير موجودة');
  return advance;
}

async function resolveOdooEmployeeId(
  session: OdooSession,
  code: string,
  name: string,
): Promise<number> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    throw new AppError(
      `لا يوجد كود موظف لـ ${name || 'الموظف'}، ولا يمكن مطابقته في Odoo`,
      400,
      'ODOO_EMPLOYEE_CODE_MISSING',
    );
  }
  for (const field of ['barcode', 'identification_id']) {
    const rows = await searchRead<{ id: number }>(
      'hr.employee',
      [[field, '=', cleanCode]],
      ['id'],
      { limit: 1 },
      session,
    );
    if (rows[0]?.id) return rows[0].id;
  }
  throw new AppError(
    `الموظف ${name || cleanCode} (كود ${cleanCode}) غير موجود في Odoo`,
    400,
    'ODOO_EMPLOYEE_MISSING',
  );
}

async function findOdooAdvance(
  session: OdooSession,
  advance: LongAdvanceForOdoo,
): Promise<number | null> {
  if (advance.odooAdvanceLongId) {
    const rows = await searchRead<{ id: number }>(
      'biotime.advance.long',
      [['id', '=', advance.odooAdvanceLongId]],
      ['id'],
      { limit: 1 },
      session,
    );
    if (rows[0]?.id) return rows[0].id;
  }
  const rows = await searchRead<{ id: number }>(
    'biotime.advance.long',
    [['note', 'ilike', longAdvanceOdooMarker(advance.id)]],
    ['id'],
    { limit: 1, order: 'id desc' },
    session,
  );
  return rows[0]?.id ?? null;
}

async function findAccountsSend(
  session: OdooSession,
  advanceLongId: number,
  localAccountsSendId?: number | null,
): Promise<{ id: number; name: string; moveId: number | null }> {
  const domain = localAccountsSendId
    ? [['id', '=', localAccountsSendId]]
    : [['advance_long_id', '=', advanceLongId]];
  let rows = await searchRead<{
    id: number;
    name: string;
    entry_move_id: false | [number, string];
  }>(
    'biotime.advance.long.accounts.send',
    domain,
    ['id', 'name', 'entry_move_id'],
    { limit: 1, order: 'id desc' },
    session,
  );
  if (!rows[0] && localAccountsSendId) {
    rows = await searchRead(
      'biotime.advance.long.accounts.send',
      [['advance_long_id', '=', advanceLongId]],
      ['id', 'name', 'entry_move_id'],
      { limit: 1, order: 'id desc' },
      session,
    );
  }
  const row = rows[0];
  return {
    id: row?.id ?? 0,
    name: row?.name ?? '',
    moveId: Array.isArray(row?.entry_move_id) ? row.entry_move_id[0] : null,
  };
}

async function persistSyncError(advanceId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
  await prisma.advanceLong
    .update({ where: { id: advanceId }, data: { odooSyncError: message } })
    .catch(() => undefined);
}

export async function sendLongAdvanceToOdoo(
  advanceId: string,
): Promise<OdooLongAdvanceResult> {
  try {
    const config = await getOdooConfig();
    if (!config.integrationEnabled) {
      throw new AppError(
        'Odoo Integration غير مفعّل في الإعدادات',
        400,
        'VALIDATION',
      );
    }

    const advance = await loadLongAdvance(advanceId);
    if (
      advance.state !== AdvanceState.running &&
      advance.state !== AdvanceState.done
    ) {
      throw new AppError(
        'فعّل السلفة الطويلة أولاً قبل إرسالها إلى Odoo',
        400,
        'ACTION_ERROR',
      );
    }

    const session = await authenticateOdooOrm();
    const employeeId = await resolveOdooEmployeeId(
      session,
      advance.employee.code ?? '',
      advance.employee.name,
    );
    const vals = buildOdooLongAdvanceVals(advance, employeeId);

    let odooAdvanceLongId = await findOdooAdvance(session, advance);
    if (!odooAdvanceLongId) {
      odooAdvanceLongId = await executeKw<number>(
        'biotime.advance.long',
        'create',
        [vals],
        KW_CTX,
        session,
      );
    }
    if (!odooAdvanceLongId) {
      throw new AppError(
        'فشل إنشاء السلفة الطويلة في Odoo',
        502,
        'ODOO_LONG_ADVANCE_CREATE',
      );
    }
    await prisma.advanceLong.update({
      where: { id: advance.id },
      data: { odooAdvanceLongId, odooSyncError: null },
    });

    let send = await findAccountsSend(
      session,
      odooAdvanceLongId,
      advance.odooAccountsSendId,
    );
    if (!send.id) {
      const accountsSendId = await executeKw<number>(
        'biotime.advance.long.accounts.send',
        'create',
        [{ advance_long_id: odooAdvanceLongId }],
        KW_CTX,
        session,
      );
      if (!accountsSendId) {
        throw new AppError(
          'فشل إنشاء سجل إرسال السلفة الطويلة للحسابات في Odoo',
          502,
          'ODOO_LONG_ADVANCE_SEND_CREATE',
        );
      }
      await prisma.advanceLong.update({
        where: { id: advance.id },
        data: { odooAccountsSendId: accountsSendId },
      });
      send = await findAccountsSend(session, odooAdvanceLongId, accountsSendId);
    }

    if (!send.moveId) {
      await executeKw(
        'biotime.advance.long.accounts.send',
        'action_create_journal_entry',
        [[send.id]],
        KW_CTX,
        session,
      );
      send = await findAccountsSend(session, odooAdvanceLongId, send.id);
    }
    if (!send.moveId) {
      throw new AppError(
        'تم إرسال السلفة إلى Odoo لكن لم يتم إنشاء القيد المسودة',
        502,
        'ODOO_LONG_ADVANCE_MOVE_MISSING',
      );
    }

    const moves = await searchRead<{ id: number; name: string; state: string }>(
      'account.move',
      [['id', '=', send.moveId]],
      ['id', 'name', 'state'],
      { limit: 1 },
      session,
    );
    const move = moves[0];
    if (!move) {
      throw new AppError(
        'تعذر قراءة قيد السلفة الطويلة في Odoo',
        502,
        'ODOO_LONG_ADVANCE_MOVE_MISSING',
      );
    }
    if (move.state !== 'draft') {
      throw new AppError(
        `قيد السلفة في Odoo ليس مسودة (الحالة: ${move.state})`,
        409,
        'ODOO_LONG_ADVANCE_MOVE_NOT_DRAFT',
      );
    }

    const moveName = move.name || String(move.id);
    await prisma.$transaction([
      prisma.advanceLong.update({
        where: { id: advance.id },
        data: {
          odooAdvanceLongId,
          odooAccountsSendId: send.id,
          odooMoveId: move.id,
          odooMoveName: moveName,
          odooSentAt: new Date(),
          odooSyncError: null,
        },
      }),
      prisma.odooConfig.update({
        where: { id: config.id },
        data: { lastPushAt: new Date() },
      }),
    ]);

    return {
      advanceLongId: odooAdvanceLongId,
      accountsSendId: send.id,
      moveId: move.id,
      moveName,
      sendReference: send.name || String(send.id),
    };
  } catch (error) {
    await persistSyncError(advanceId, error);
    throw error;
  }
}
