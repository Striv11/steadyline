import { describe, expect, it } from 'vitest';
import {
  localDate,
  localToUtc,
  occurrences,
  parseRule,
  RuleError,
} from '../src/domain/recurrence.js';

const list = (rule: string, start: string, from: string, to: string) =>
  occurrences(parseRule(rule, start), start, from, to);

describe('parseRule', () => {
  it('defaults weekly BYDAY to the start weekday', () => {
    expect(parseRule('FREQ=WEEKLY', '2026-11-04').byday).toEqual([2]); // Wednesday
  });
  it.each([
    ['FREQ=MONTHLY', 'FREQ must be'],
    ['FREQ=DAILY;INTERVAL=0', 'INTERVAL'],
    ['FREQ=DAILY;BYDAY=MO', 'only valid with FREQ=WEEKLY'],
    ['FREQ=WEEKLY;BYDAY=XX', 'unknown weekday'],
    ['FREQ=DAILY;COUNT=2;UNTIL=20261201', 'not both'],
    ['FREQ=DAILY;BYHOUR=3', 'unsupported'],
    ['FREQ=DAILY;FREQ=DAILY', 'duplicate'],
    ['FREQ=DAILY;COUNT=999', 'COUNT'],
    ['FREQ=DAILY;UNTIL=2026-12-01', 'UNTIL'],
    ['', 'malformed'],
  ])('rejects %s', (rule, msg) => {
    expect(() => parseRule(rule, '2026-11-04')).toThrow(RuleError);
    expect(() => parseRule(rule, '2026-11-04')).toThrow(msg);
  });
});

describe('occurrences', () => {
  it('daily every day and every 2 days', () => {
    expect(list('FREQ=DAILY', '2026-11-02', '2026-11-02', '2026-11-05')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(list('FREQ=DAILY;INTERVAL=2', '2026-11-02', '2026-11-03', '2026-11-08')).toEqual([
      '2026-11-04',
      '2026-11-06',
      '2026-11-08',
    ]);
  });
  it('weekly on several weekdays, Monday-based', () => {
    // 2026-11-02 is a Monday.
    expect(list('FREQ=WEEKLY;BYDAY=MO,TH', '2026-11-02', '2026-11-02', '2026-11-16')).toEqual([
      '2026-11-02',
      '2026-11-05',
      '2026-11-09',
      '2026-11-12',
      '2026-11-16',
    ]);
  });
  it('fortnightly keeps alternating weeks, and a mid-week start skips earlier days', () => {
    // Start Wednesday 11-04 with MO,WE: week 1 gives only Wed 11-04; week 3 gives Mon 11-16, Wed 11-18.
    expect(
      list('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', '2026-11-04', '2026-11-01', '2026-11-30'),
    ).toEqual(['2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30']);
  });
  it('COUNT counts from the start even when the window starts later', () => {
    expect(list('FREQ=DAILY;COUNT=5', '2026-11-02', '2026-11-05', '2026-12-31')).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
  });
  it('UNTIL is inclusive', () => {
    expect(list('FREQ=DAILY;UNTIL=20261104', '2026-11-02', '2026-11-01', '2026-12-31')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });
  it('never yields dates before the start', () => {
    expect(list('FREQ=DAILY', '2026-11-10', '2026-11-01', '2026-11-11')).toEqual([
      '2026-11-10',
      '2026-11-11',
    ]);
  });
  it('crosses month and year ends', () => {
    expect(list('FREQ=WEEKLY;BYDAY=TH', '2026-12-24', '2026-12-24', '2027-01-14')).toEqual([
      '2026-12-24',
      '2026-12-31',
      '2027-01-07',
      '2027-01-14',
    ]);
  });
});

describe('local time', () => {
  it('converts IST wall-clock time to UTC and back', () => {
    const at = localToUtc('2026-11-04', '09:00', 330);
    expect(at.toISOString()).toBe('2026-11-04T03:30:00.000Z');
    expect(localDate(at, 330)).toBe('2026-11-04');
  });
  it('an early-morning local visit falls on the previous UTC day', () => {
    const at = localToUtc('2026-11-04', '05:00', 330);
    expect(at.toISOString()).toBe('2026-11-03T23:30:00.000Z');
    expect(localDate(at, 330)).toBe('2026-11-04');
  });
  it('rejects bad times', () => {
    expect(() => localToUtc('2026-11-04', '25:00', 330)).toThrow(RuleError);
  });
});
