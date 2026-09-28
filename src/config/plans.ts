export const PLANS = ['free', 'pro'] as const

export type Plan = (typeof PLANS)[number]

export interface PlanLimits {
  linksPerMonth: number
  redirectsPerMonth: number
  customAlias: boolean
}

export const PLAN_LIMITS: Readonly<Record<Plan, Readonly<PlanLimits>>> = Object.freeze({
  free: Object.freeze({
    linksPerMonth: 100,
    redirectsPerMonth: 10_000,
    customAlias: true,
  }),
  pro: Object.freeze({
    linksPerMonth: 10_000,
    redirectsPerMonth: 1_000_000,
    customAlias: true,
  }),
})

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value)
}

export function limitsFor(plan: Plan | null | undefined): Readonly<PlanLimits> {
  return PLAN_LIMITS[plan ?? 'free']
}
