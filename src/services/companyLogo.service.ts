import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma/client';
import { requireCompanyId } from '../tenant/context';

function uploadRootForCompany(companyId: string): string {
  return path.join(process.cwd(), 'uploads', companyId, 'company');
}

const LOGO_FILENAME = 'logo';

function stripBase64Payload(input: string): string {
  const comma = input.indexOf(',');
  return comma >= 0 ? input.slice(comma + 1) : input;
}

function extFromMime(mimeType?: string): string {
  const m = (mimeType ?? '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  return 'jpg';
}

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}

async function getConfigRow() {
  const companyId = requireCompanyId();
  const existing = await prisma.bioTimeConfig.findUnique({ where: { companyId } });
  if (existing) return existing;
  return prisma.bioTimeConfig.create({ data: { companyId, authType: 'jwt' } });
}

export async function saveCompanyLogo(base64: string, mimeType?: string): Promise<{ relativePath: string }> {
  const companyId = requireCompanyId();
  const config = await getConfigRow();
  const root = uploadRootForCompany(companyId);
  await fs.mkdir(root, { recursive: true });

  const ext = extFromMime(mimeType);
  const filename = `${LOGO_FILENAME}.${ext}`;
  const fullPath = path.join(root, filename);
  const buf = Buffer.from(stripBase64Payload(base64), 'base64');
  if (!buf.length) throw new Error('ملف فارغ');

  if (!mimeType?.toLowerCase().startsWith('image/')) {
    throw new Error('يجب أن يكون الملف صورة (PNG أو JPG أو WebP)');
  }

  await fs.writeFile(fullPath, buf);

  if (config.companyLogoPath && config.companyLogoPath !== filename) {
    try {
      await fs.unlink(path.join(root, config.companyLogoPath));
    } catch {
      // ignore missing old file
    }
  }

  await prisma.bioTimeConfig.update({
    where: { id: config.id },
    data: { companyLogoPath: filename },
  });

  return { relativePath: filename };
}

export async function readCompanyLogo(): Promise<{ base64: string; mimeType: string; filename: string } | null> {
  const companyId = requireCompanyId();
  const config = await getConfigRow();
  if (!config.companyLogoPath) return null;

  const fullPath = path.join(uploadRootForCompany(companyId), config.companyLogoPath);
  try {
    const buf = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).slice(1) || 'jpg';
    return {
      base64: buf.toString('base64'),
      mimeType: mimeFromExt(ext),
      filename: config.companyLogoPath,
    };
  } catch {
    return null;
  }
}

export async function readCompanyLogoDataUri(): Promise<string | null> {
  const file = await readCompanyLogo();
  if (!file) return null;
  return `data:${file.mimeType};base64,${file.base64}`;
}

export async function deleteCompanyLogo(): Promise<void> {
  const companyId = requireCompanyId();
  const config = await getConfigRow();
  if (!config.companyLogoPath) return;

  try {
    await fs.unlink(path.join(uploadRootForCompany(companyId), config.companyLogoPath));
  } catch {
    // ignore
  }

  await prisma.bioTimeConfig.update({
    where: { id: config.id },
    data: { companyLogoPath: null },
  });
}

export function hasCompanyLogo(config: { companyLogoPath?: string | null }): boolean {
  return Boolean(config.companyLogoPath?.trim());
}
