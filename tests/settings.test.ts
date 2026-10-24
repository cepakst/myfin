import { describe, expect, it } from 'vitest';
import { defaultSettings, profileFor, uses16a, withYearProfile } from '../src/core/settings.js';

describe('withYearProfile', () => {
  it('stores only the patched fields so the year keeps following the default situation', () => {
    const s = { ...defaultSettings(), defaultSituation: 'EMPLOYEE' as const };
    const next = withYearProfile(s, 2024, { foreign16a: false });
    expect(next.taxProfiles[2024]).toEqual({ foreign16a: false });
    expect(uses16a(next, 2024)).toBe(false);
    expect(profileFor(next, 2024).situation).toBe('EMPLOYEE');
    expect(profileFor({ ...next, defaultSituation: 'NO_INCOME' }, 2024).situation).toBe('NO_INCOME');
  });

  it('patches an existing profile and keeps other fields and years', () => {
    const s = { ...defaultSettings(), taxProfiles: { 2023: { situation: 'OSVC' as const, otherTaxBase: 500_000 }, 2024: { situation: 'NO_INCOME' as const } } };
    const next = withYearProfile(s, 2023, { situation: 'OSVC_PAUSAL' });
    expect(next.taxProfiles[2023]).toEqual({ situation: 'OSVC_PAUSAL', otherTaxBase: 500_000 });
    expect(next.taxProfiles[2024]).toEqual({ situation: 'NO_INCOME' });
  });

  it('clears a field with undefined and removes an empty profile', () => {
    const s = { ...defaultSettings(), taxProfiles: { 2024: { situation: 'EMPLOYEE' as const, otherTaxBase: 1 } } };
    const cleared = withYearProfile(s, 2024, { situation: undefined });
    expect(cleared.taxProfiles[2024]).toEqual({ otherTaxBase: 1 });
    expect(profileFor(cleared, 2024).situation).toBe('OSVC');
    const empty = withYearProfile(cleared, 2024, { otherTaxBase: undefined });
    expect(2024 in empty.taxProfiles).toBe(false);
  });

  it('does not mutate the input settings', () => {
    const s = { ...defaultSettings(), taxProfiles: { 2024: { situation: 'EMPLOYEE' as const } } };
    withYearProfile(s, 2024, { situation: undefined, otherTaxBase: 1 });
    expect(s.taxProfiles).toEqual({ 2024: { situation: 'EMPLOYEE' } });
  });

  it('never applies §16a before 2021', () => {
    const s = withYearProfile(defaultSettings(), 2020, { foreign16a: true });
    expect(uses16a(s, 2020)).toBe(false);
  });
});
