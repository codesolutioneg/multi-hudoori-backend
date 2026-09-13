import { Router } from 'express';
import { prisma } from '../prisma/client';
import { asyncHandler } from '../middlewares/asyncHandler';

const router = Router();

function normalizeIsPublish(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value ?? 'false').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' ? 'true' : 'false';
}

function toDto(row: { id: number; isPublish: string; version: string }) {
  return {
    id: row.id,
    isPublish: row.isPublish,
    version: row.version,
  };
}

/** GET /api/Authenticate/GetAllMobileVersions */
router.get(
  '/GetAllMobileVersions',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.mobileVersion.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, isPublish: true, version: true },
    });
    res.json(rows.map(toDto));
  }),
);

/** POST /api/Authenticate/AddMobileUpdate */
router.post(
  '/AddMobileUpdate',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = String(body.version ?? '').trim();
    if (!version) {
      res.status(400).json({ success: false, message: 'version is required' });
      return;
    }

    const isPublish = normalizeIsPublish(body.isPublish);
    const idRaw = body.id;
    const hasExplicitId =
      idRaw !== undefined && idRaw !== null && String(idRaw).trim() !== '' && Number(idRaw) > 0;

    const created = hasExplicitId
      ? await prisma.mobileVersion.create({
          data: {
            id: Number(idRaw),
            version,
            isPublish,
          },
          select: { id: true, isPublish: true, version: true },
        })
      : await prisma.mobileVersion.create({
          data: { version, isPublish },
          select: { id: true, isPublish: true, version: true },
        });

    res.status(200).json(toDto(created));
  }),
);

/** PUT /api/Authenticate/UpdateMobileUpdate/:id */
router.put(
  '/UpdateMobileUpdate/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: 'Invalid id' });
      return;
    }

    const existing = await prisma.mobileVersion.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Mobile version not found' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: { version?: string; isPublish?: string } = {};

    if (body.version !== undefined) {
      const version = String(body.version).trim();
      if (!version) {
        res.status(400).json({ success: false, message: 'version cannot be empty' });
        return;
      }
      data.version = version;
    }
    if (body.isPublish !== undefined) {
      data.isPublish = normalizeIsPublish(body.isPublish);
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, message: 'Provide version and/or isPublish' });
      return;
    }

    const updated = await prisma.mobileVersion.update({
      where: { id },
      data,
      select: { id: true, isPublish: true, version: true },
    });

    res.status(200).json(toDto(updated));
  }),
);

export default router;
