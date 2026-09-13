import { prisma } from '../src/prisma/client';
import { syncAllMergedManualOtLines } from '../src/services/shiftGridManualOt.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await syncAllMergedManualOtLines({ apply });

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        gridCount: result.gridCount,
        addedCount: result.addedCount,
        changedGrids: result.results
          .filter((row) => row.addedCount > 0)
          .map((row) => ({
            gridId: row.gridId,
            name: row.name,
            sourceGridCount: row.sourceGridCount,
            sourceLineCount: row.sourceLineCount,
            existingCount: row.existingCount,
            addedCount: row.addedCount,
          })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
