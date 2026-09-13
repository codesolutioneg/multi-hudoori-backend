import { describe, it, expect } from 'vitest';
import {
  jobTitleRank,
  computeEffectiveParents,
  type RankResolver,
} from '../../src/services/orgChart.service';

/** Minimal shape `computeEffectiveParents` reads; the DB rows carry far more. */
type Emp = {
  id: string;
  name: string;
  code?: string | null;
  jobTitle?: string | null;
  locationId?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
};

function emp(id: string, over: Partial<Emp> = {}): Emp {
  return {
    id,
    name: id,
    code: id,
    jobTitle: null,
    locationId: 'site-a',
    departmentId: null,
    managerId: null,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parentsOf = (rows: Emp[], rankOf?: RankResolver) =>
  computeEffectiveParents(rows as any, rankOf);

describe('jobTitleRank', () => {
  it('ranks the built-in ladder from area head down to staff', () => {
    expect(jobTitleRank('مدير منطقه')).toBe(1);
    expect(jobTitleRank('مدير الفرع')).toBe(2);
    expect(jobTitleRank('مدير المصنع')).toBe(2);
    expect(jobTitleRank('مدير المخزن')).toBe(3);
    expect(jobTitleRank('مساعد مدير')).toBe(3);
    expect(jobTitleRank('شيفت ليدر')).toBe(4);
    expect(jobTitleRank('سوبر فايزر')).toBe(4);
    expect(jobTitleRank('ويتر')).toBe(5);
  });

  it('normalises hamza, ya, ta-marbuta, tatweel and diacritics before matching', () => {
    // Same title, five ways of writing it — all must land on area head.
    for (const variant of [
      'مدير منطقة',
      'مدير منطقه',
      'مُدير منطقه',
      'مدير  منطقه ',
      'مديـر منطقه',
    ]) {
      expect(jobTitleRank(variant), variant).toBe(1);
    }
  });

  it('treats an unknown «مدير …» as a department head, not staff', () => {
    expect(jobTitleRank('مدير التسويق الرقمي')).toBe(3);
  });

  it('falls back to staff for empty or unknown titles', () => {
    expect(jobTitleRank(null)).toBe(5);
    expect(jobTitleRank('')).toBe(5);
    expect(jobTitleRank('حاجة مالهاش لازمة')).toBe(5);
  });
});

describe('computeEffectiveParents', () => {
  it('hangs staff off the site head', () => {
    const rows = [
      emp('head', { jobTitle: 'مدير الفرع' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('head')).toBeNull();
    expect(parents.get('waiter')).toBe('head');
  });

  it('attaches to the NEAREST rank above, not the most senior', () => {
    const rows = [
      emp('area', { jobTitle: 'مدير منطقه' }),
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('shift', { jobTitle: 'شيفت ليدر' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('area')).toBeNull();
    expect(parents.get('branch')).toBe('area');
    expect(parents.get('shift')).toBe('branch');
    expect(parents.get('waiter')).toBe('shift');
  });

  it('prefers a senior in the same department over a closer rank elsewhere', () => {
    const rows = [
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('kitchenHead', { jobTitle: 'مدير مطبخ', departmentId: 'kitchen' }),
      emp('hallShift', { jobTitle: 'شيفت ليدر', departmentId: 'hall' }),
      emp('cook', { jobTitle: 'شيف', departmentId: 'kitchen' }),
    ];
    // The hall shift leader is a closer rank (4) than the kitchen head (3),
    // but the cook belongs to the kitchen so the department wins.
    expect(parentsOf(rows).get('cook')).toBe('kitchenHead');
  });

  it('never links across sites when deriving', () => {
    const rows = [
      emp('headA', { jobTitle: 'مدير الفرع', locationId: 'site-a' }),
      emp('waiterB', { jobTitle: 'ويتر', locationId: 'site-b' }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('waiterB')).toBeNull();
  });

  it('leaves employees without a site as roots', () => {
    const rows = [
      emp('head', { jobTitle: 'مدير الفرع', locationId: null }),
      emp('waiter', { jobTitle: 'ويتر', locationId: null }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('head')).toBeNull();
    expect(parents.get('waiter')).toBeNull();
  });

  it('lets a manual manager override the derived line', () => {
    const rows = [
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('shift', { jobTitle: 'شيفت ليدر' }),
      emp('waiter', { jobTitle: 'ويتر', managerId: 'branch' }),
    ];
    // Derivation would put the waiter under the shift leader.
    expect(parentsOf(rows).get('waiter')).toBe('branch');
  });

  it('keeps a manual link even when it points UP the ladder the wrong way', () => {
    const rows = [
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('shift', { jobTitle: 'شيفت ليدر', managerId: 'waiter' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    // Deliberate: HR said this person reports there, so the chart obeys.
    expect(parentsOf(rows).get('shift')).toBe('waiter');
  });

  it('ignores a manual manager who is outside the requested scope', () => {
    const rows = [
      emp('head', { jobTitle: 'مدير الفرع' }),
      emp('waiter', { jobTitle: 'ويتر', managerId: 'someone-not-loaded' }),
    ];
    // Falls back to derivation rather than orphaning the node.
    expect(parentsOf(rows).get('waiter')).toBe('head');
  });

  it('keeps the manual placement when derivation would loop back on it', () => {
    // Regression: moving a shift leader under a waiter used to vanish, because the
    // waiter then derived back under that same shift leader and the cycle breaker
    // cut the manual link — the edit disappeared from the tree on next load.
    const rows = [
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('shift', { jobTitle: 'شيفت ليدر', managerId: 'waiter' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('shift')).toBe('waiter');
    // The waiter re-derives past the loop, up to the branch head.
    expect(parents.get('waiter')).toBe('branch');
  });

  it('survives a chain of manual placements that inverts the ladder', () => {
    const rows = [
      emp('branch', { jobTitle: 'مدير الفرع' }),
      emp('waiter', { jobTitle: 'ويتر', managerId: 'branch' }),
      emp('shift', { jobTitle: 'شيفت ليدر', managerId: 'waiter' }),
      emp('cook', { jobTitle: 'شيف', managerId: 'shift' }),
    ];
    const parents = parentsOf(rows);
    expect(parents.get('waiter')).toBe('branch');
    expect(parents.get('shift')).toBe('waiter');
    expect(parents.get('cook')).toBe('shift');
  });

  it('breaks a manual cycle instead of looping forever', () => {
    const rows = [
      emp('a', { managerId: 'b' }),
      emp('b', { managerId: 'c' }),
      emp('c', { managerId: 'a' }),
    ];
    const parents = parentsOf(rows);
    const nulled = ['a', 'b', 'c'].filter((id) => parents.get(id) === null);
    expect(nulled.length).toBeGreaterThan(0);
  });

  it('picks the same senior on every run when several tie', () => {
    const rows = [
      emp('m1', { jobTitle: 'مدير الفرع', code: 'B002' }),
      emp('m2', { jobTitle: 'مدير الفرع', code: 'B001' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    const first = parentsOf(rows).get('waiter');
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(parentsOf(shuffled).get('waiter')).toBe(first);
    // Lowest code breaks the tie, so the answer is stable across requests.
    expect(first).toBe('m2');
  });

  it('uses a configured ladder in place of the built-in guess', () => {
    const rows = [
      emp('accountant', { jobTitle: 'محاسب مالي' }),
      emp('waiter', { jobTitle: 'ويتر' }),
    ];
    // Both are staff by default, so nobody manages anybody.
    expect(parentsOf(rows).get('waiter')).toBeNull();

    // Promote «محاسب مالي» the way the settings screen would.
    const ladder: RankResolver = (t) => (String(t ?? '') === 'محاسب مالي' ? 4 : 5);
    expect(parentsOf(rows, ladder).get('waiter')).toBe('accountant');
  });

  it('drops everyone to roots when the ladder makes them all equal', () => {
    const rows = [
      emp('a', { jobTitle: 'مدير الفرع' }),
      emp('b', { jobTitle: 'ويتر' }),
    ];
    const flat: RankResolver = () => 5;
    const parents = parentsOf(rows, flat);
    expect(parents.get('a')).toBeNull();
    expect(parents.get('b')).toBeNull();
  });
});
