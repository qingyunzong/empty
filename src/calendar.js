import { PlanError } from './errors.js'

export const MINUTES_PER_DAY = 1440

// All times are integer minutes since the Unix epoch (UTC).
export function parseInstant(value, field) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(ms)) {
    throw new PlanError('VALIDATION', `invalid datetime for ${field}: ${value}`)
  }
  return Math.round(ms / 60000)
}

export function toISO(minutes) {
  return new Date(minutes * 60000).toISOString()
}

function parseHHMM(value, field) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof value === 'string' ? value : '')
  if (!m) throw new PlanError('VALIDATION', `invalid time for ${field}: ${value}`)
  const minutes = Number(m[1]) * 60 + Number(m[2])
  if (minutes >= MINUTES_PER_DAY) {
    throw new PlanError('VALIDATION', `time out of range for ${field}: ${value}`)
  }
  return minutes
}

// Subtract sorted [s,e) cut intervals from sorted base intervals.
// Zero-length results are dropped, so abutting busy/downtime intervals
// can never produce zero-length gaps.
export function subtractIntervals(base, cuts) {
  let result = base.filter(([s, e]) => e > s).map(([s, e]) => [s, e])
  for (const [cs, ce] of cuts) {
    if (ce <= cs) continue
    const next = []
    for (const [s, e] of result) {
      if (ce <= s || cs >= e) {
        next.push([s, e])
        continue
      }
      if (s < cs) next.push([s, cs])
      if (ce < e) next.push([ce, e])
    }
    result = next
  }
  return result.filter(([s, e]) => e > s)
}

// Builds the global availability timeline from periodic shifts,
// rest-day exceptions and global downtime intervals.
export function buildCalendar(config) {
  if (!config || typeof config !== 'object') {
    throw new PlanError('VALIDATION', 'calendar config is required')
  }
  const start = parseInstant(config.start, 'calendar.start')
  if (start % MINUTES_PER_DAY !== 0) {
    throw new PlanError('VALIDATION', 'calendar.start must be a UTC midnight (YYYY-MM-DDT00:00:00Z)')
  }
  if (!Number.isInteger(config.days) || config.days <= 0) {
    throw new PlanError('VALIDATION', 'calendar.days must be a positive integer')
  }
  const end = start + config.days * MINUTES_PER_DAY

  const shifts = config.shifts ?? []
  if (!Array.isArray(shifts)) {
    throw new PlanError('VALIDATION', 'calendar.shifts must be an array')
  }
  const parsedShifts = shifts.map((shift, i) => {
    const s = parseHHMM(shift?.start, `calendar.shifts[${i}].start`)
    const e = parseHHMM(shift?.end, `calendar.shifts[${i}].end`)
    if (e <= s) {
      throw new PlanError('VALIDATION', `calendar.shifts[${i}]: end must be after start (overnight shifts are not supported)`)
    }
    if (!Array.isArray(shift.days) || shift.days.length === 0 ||
        !shift.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new PlanError('VALIDATION', `calendar.shifts[${i}].days must be an array of integers 0..6 (0 = Sunday)`)
    }
    return { start: s, end: e, days: shift.days }
  })

  const restDays = new Set(config.restDays ?? [])
  for (const d of restDays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new PlanError('VALIDATION', `invalid rest day: ${d}`)
    }
  }

  const shiftIntervals = []
  for (let d = 0; d < config.days; d++) {
    const dayStart = start + d * MINUTES_PER_DAY
    const date = toISO(dayStart).slice(0, 10)
    if (restDays.has(date)) continue
    const dow = new Date(dayStart * 60000).getUTCDay()
    const dayIntervals = []
    for (const shift of parsedShifts) {
      if (!shift.days.includes(dow)) continue
      dayIntervals.push([dayStart + shift.start, dayStart + shift.end])
    }
    dayIntervals.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < dayIntervals.length; i++) {
      if (dayIntervals[i][0] < dayIntervals[i - 1][1]) {
        throw new PlanError('CALENDAR_OVERLAP', `overlapping shifts on ${date}`)
      }
    }
    shiftIntervals.push(...dayIntervals)
  }

  const downtimes = (config.downtimes ?? []).map((dt, i) => {
    const s = parseInstant(dt?.start, `calendar.downtimes[${i}].start`)
    const e = parseInstant(dt?.end, `calendar.downtimes[${i}].end`)
    if (e <= s) {
      throw new PlanError('VALIDATION', `calendar.downtimes[${i}]: end must be after start`)
    }
    return [s, e]
  }).sort((a, b) => a[0] - b[0])
  for (let i = 1; i < downtimes.length; i++) {
    if (downtimes[i][0] < downtimes[i - 1][1]) {
      throw new PlanError(
        'CALENDAR_OVERLAP',
        `overlapping downtime intervals starting at ${toISO(downtimes[i - 1][0])} and ${toISO(downtimes[i][0])}`,
      )
    }
  }

  const availability = subtractIntervals(shiftIntervals, downtimes)
  return { start, end, days: config.days, availability }
}
