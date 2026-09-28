import { describe, expect, it } from 'vitest'
import { PLAN_LIMITS, isPlan, limitsFor, type Plan } from '../../src/config/plans.js'

describe('plans', () => {
  it('resolves anonymous callers to the free tier', () => {
    expect(limitsFor(null)).toBe(PLAN_LIMITS.free)
    expect(limitsFor(undefined)).toBe(PLAN_LIMITS.free)
  })

  it('resolves a known plan to its own limits', () => {
    expect(limitsFor('pro')).toBe(PLAN_LIMITS.pro)
  })

  it('never returns limits weaker than the free tier', () => {
    const free = PLAN_LIMITS.free
    for (const plan of Object.keys(PLAN_LIMITS) as Plan[]) {
      expect(limitsFor(plan).linksPerMonth).toBeGreaterThanOrEqual(free.linksPerMonth)
      expect(limitsFor(plan).redirectsPerMonth).toBeGreaterThanOrEqual(free.redirectsPerMonth)
    }
  })

  it('is immutable', () => {
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true)
    expect(Object.isFrozen(PLAN_LIMITS.free)).toBe(true)
  })

  it('recognises valid plan names only', () => {
    expect(isPlan('free')).toBe(true)
    expect(isPlan('pro')).toBe(true)
    expect(isPlan('enterprise')).toBe(false)
    expect(isPlan(null)).toBe(false)
    expect(isPlan(1)).toBe(false)
  })

  it('gives every plan all three limit dimensions', () => {
    for (const [name, limits] of Object.entries(PLAN_LIMITS)) {
      expect(typeof limits.linksPerMonth, name).toBe('number')
      expect(typeof limits.redirectsPerMonth, name).toBe('number')
      expect(typeof limits.customAlias, name).toBe('boolean')
    }
  })
})
