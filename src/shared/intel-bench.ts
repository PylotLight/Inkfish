export type IntelBenchKind = 'fields' | 'items' | 'label' | 'facts'

export interface IntelBenchCase {
  id: string
  task: IntelBenchKind
  title: string
  document: string
  prompt: string
  expected?: Record<string, string | string[]>
  expectedItems?: Array<Record<string, string>>
  expectedLabel?: string
  requiredFacts?: string[][]
}

/**
 * Synthetic, versioned benchmark examples. They contain no personal data and are intentionally
 * structured so most scoring can use exact field/value math rather than an LLM judge.
 */
export const INTEL_BENCH_CASES: IntelBenchCase[] = [
  {
    id: 'invoice-fields-v1',
    task: 'fields',
    title: 'Invoice key fields',
    document: `Coastline Stationery Pty Ltd\nTax invoice CS-1842\nIssued: 21 September 2026\nDue: 21 October 2026\nPurchase order: PO-739\nSubtotal: AUD 960.00\nGST: AUD 96.00\nTotal due: AUD 1,056.00`,
    prompt:
      'Extract the invoice fields from the document. Return exactly one JSON object with string values for supplier, invoice_number, issue_date, due_date, purchase_order, currency, subtotal, gst and total. Use ISO dates (YYYY-MM-DD), amounts as decimal numbers without currency symbols or thousands separators, and an ISO 4217 currency code.',
    expected: {
      supplier: 'Coastline Stationery Pty Ltd',
      invoice_number: 'CS-1842',
      issue_date: '2026-09-21',
      due_date: '2026-10-21',
      purchase_order: 'PO-739',
      currency: 'AUD',
      subtotal: '960.00',
      gst: '96.00',
      total: '1056.00'
    }
  },
  {
    id: 'meeting-actions-v1',
    task: 'items',
    title: 'Meeting commitments',
    document: `Product launch check-in, 28 October 2026. Maya will email the revised design to the team by 30 October. Theo agreed to compare quotes from two suppliers by 2 November. The pilot starts on 5 November, but only after Legal signs off. No one was assigned to book the launch venue.`,
    prompt:
      'Extract only explicit person-owned action items. Return exactly one JSON object with an "items" array. Each item must have string fields owner, action and due; use ISO dates (YYYY-MM-DD), or an empty string when no due date is stated. Do not turn decisions or unassigned work into action items.',
    expectedItems: [
      { owner: 'Maya', action: 'Email the revised design to the team', due: '2026-10-30' },
      { owner: 'Theo', action: 'Compare quotes from two suppliers', due: '2026-11-02' }
    ]
  },
  {
    id: 'document-routing-v1',
    task: 'label',
    title: 'Document classification',
    document: `CUSTOMER DATA PROCESSING ADDENDUM\n\nEast Bay Health requires the signed privacy addendum before any production data is transferred. The revised terms must be approved by counsel and returned by 31 October 2026.`,
    prompt:
      'Classify the document as exactly one of: billing, customer_feedback, legal, project_update, hiring. Return only the selected label, with no explanation.',
    expectedLabel: 'legal'
  },
  {
    id: 'grounded-summary-v1',
    task: 'facts',
    title: 'Summary fact coverage',
    document: `Atlas Logistics approved an AUD 240,000 budget for a cold-chain monitoring rollout. The initial phase covers 12 depots, beginning in November 2026. The first pilot site is Geelong. The budget is approved, but the rollout has not started yet.`,
    prompt:
      'Write a concise one-sentence summary of the document. Include the main organisation, scope, scale, start timing and pilot location. Return exactly one JSON object with a string field "summary". Do not add facts.',
    requiredFacts: [
      ['Atlas Logistics'],
      ['cold-chain monitoring'],
      ['12 depots'],
      ['November 2026', 'Nov 2026'],
      ['Geelong']
    ]
  },
  {
    id: 'invoice-fields-v2',
    task: 'fields',
    title: 'Invoice key fields',
    document: `Harbour Print Co\nInvoice HP-7719\nInvoice date: 2 September 2026\nPayment due: 30 September 2026\nPO number: PO-8821\nNet: $420.00\nGST: $42.00\nAmount payable: AUD 462.00`,
    prompt:
      'Extract the invoice fields from the document. Return exactly one JSON object with string values for supplier, invoice_number, issue_date, due_date, purchase_order, currency, subtotal, gst and total. Use ISO dates (YYYY-MM-DD), amounts as decimal numbers without currency symbols or thousands separators, and an ISO 4217 currency code.',
    expected: {
      supplier: 'Harbour Print Co',
      invoice_number: 'HP-7719',
      issue_date: '2026-09-02',
      due_date: '2026-09-30',
      purchase_order: 'PO-8821',
      currency: 'AUD',
      subtotal: '420.00',
      gst: '42.00',
      total: '462.00'
    }
  },
  {
    id: 'invoice-fields-v3',
    task: 'fields',
    title: 'Receipt key fields',
    document: `PARKSIDE CAFE\nReceipt RC-5502\nPurchase date: 17 October 2026\nSubtotal $35.00\nGST included $3.50\nTotal paid $38.50 AUD\nCard: Mastercard`,
    prompt:
      'Extract the receipt fields from the document. Return exactly one JSON object with string values for merchant, receipt_number, purchase_date, currency, subtotal, gst and total. Use ISO dates (YYYY-MM-DD), amounts as decimal numbers without currency symbols, and an ISO 4217 currency code.',
    expected: {
      merchant: 'Parkside Cafe',
      receipt_number: 'RC-5502',
      purchase_date: '2026-10-17',
      currency: 'AUD',
      subtotal: '35.00',
      gst: '3.50',
      total: '38.50'
    }
  },
  {
    id: 'meeting-actions-v2',
    task: 'items',
    title: 'Meeting commitments',
    document: `Engineering handoff, 30 October 2026. Priya will upload the signed build notes by 2 November. Ben is responsible for verifying the Android crash fix by 3 November. The team might move the demo to 12 November, but no one owns that decision.`,
    prompt:
      'Extract only explicit person-owned action items. Return exactly one JSON object with an "items" array. Each item must have string fields owner, action and due; use ISO dates (YYYY-MM-DD), or an empty string when no due date is stated. Do not turn decisions or unassigned work into action items.',
    expectedItems: [
      { owner: 'Priya', action: 'Upload the signed build notes', due: '2026-11-02' },
      { owner: 'Ben', action: 'Verify the Android crash fix', due: '2026-11-03' }
    ]
  },
  {
    id: 'meeting-actions-v3',
    task: 'items',
    title: 'Meeting commitments',
    document: `Release check-in, 1 November 2026. Celia promised to review the onboarding copy by 4 November. Max will send the final icon pack to the release team by 5 November. The group discussed asking Finance about a larger budget, but assigned nobody to do it.`,
    prompt:
      'Extract only explicit person-owned action items. Return exactly one JSON object with an "items" array. Each item must have string fields owner, action and due; use ISO dates (YYYY-MM-DD), or an empty string when no due date is stated. Do not turn decisions or unassigned work into action items.',
    expectedItems: [
      { owner: 'Celia', action: 'Review the onboarding copy', due: '2026-11-04' },
      { owner: 'Max', action: 'Send the final icon pack to the release team', due: '2026-11-05' }
    ]
  },
  {
    id: 'document-routing-v2',
    task: 'label',
    title: 'Document classification',
    document: `PAYMENT REMINDER\n\nInvoice INV-773 is 14 days overdue. Please remit the outstanding AUD 2,140.00 to the account shown on the original invoice.`,
    prompt:
      'Classify the document as exactly one of: billing, customer_feedback, legal, project_update, hiring. Return only the selected label, with no explanation.',
    expectedLabel: 'billing'
  },
  {
    id: 'document-routing-v3',
    task: 'label',
    title: 'Document classification',
    document: `WEEKLY DELIVERY UPDATE\n\nThe migration is 80% complete. The data import is finished, and the team expects the final validation step to finish on 9 November 2026. No staffing or contract changes are requested.`,
    prompt:
      'Classify the document as exactly one of: billing, customer_feedback, legal, project_update, hiring. Return only the selected label, with no explanation.',
    expectedLabel: 'project_update'
  },
  {
    id: 'grounded-summary-v2',
    task: 'facts',
    title: 'Summary fact coverage',
    document: `Redgum Energy approved a 6-week battery monitoring trial for 4 sites. The trial begins in December 2026, with the first installation at Bendigo. The approval covers the trial only; no wider rollout has been decided.`,
    prompt:
      'Write a concise one-sentence summary. Include the organisation, purpose, duration, number of sites, start timing and first location. Return exactly one JSON object with a string field "summary". Do not add facts.',
    requiredFacts: [
      ['Redgum Energy'],
      ['battery monitoring'],
      ['6 weeks', 'six weeks'],
      ['4 sites', 'four sites'],
      ['December 2026', 'Dec 2026'],
      ['Bendigo']
    ]
  },
  {
    id: 'grounded-summary-v3',
    task: 'facts',
    title: 'Summary fact coverage',
    document: `Sapphire Robotics will deliver 8 warehouse prototypes to Northstar Retail for testing. Delivery is scheduled for 14 December 2026 in Newcastle. This is a test batch and is not a production order.`,
    prompt:
      'Write a concise one-sentence summary. Include the organisations, prototype quantity, delivery date, location and the fact that it is a test batch. Return exactly one JSON object with a string field "summary". Do not add facts.',
    requiredFacts: [
      ['Sapphire Robotics'],
      ['Northstar Retail'],
      ['8 warehouse prototypes', 'eight warehouse prototypes'],
      ['14 December 2026', '2026-12-14'],
      ['Newcastle'],
      ['test batch']
    ]
  }
]

export interface IntelBenchScore {
  score: number
  precision?: number
  recall?: number
  f1?: number
  valid: boolean
  detail: string
}

export function normalizeBenchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-AU')
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizedField(key: string, value: string): string {
  if (key.endsWith('_date') || key === 'due') {
    const raw = value.trim()
    const au = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(raw)
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
    const date = au
      ? new Date(Date.UTC(Number(au[3]), Number(au[2]) - 1, Number(au[1])))
      : iso
        ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
        : new Date(raw)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  }
  if (['subtotal', 'gst', 'total', 'amount', 'value'].includes(key)) {
    const number = Number(value.replace(/,/g, '').replace(/[^\d.+-]/g, ''))
    if (Number.isFinite(number)) return number.toFixed(2)
  }
  return normalizeBenchText(value)
}

export function parseBenchJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function accepted(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string')
  return []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

export function scoreIntelBenchCase(testCase: IntelBenchCase, output: string): IntelBenchScore {
  if (testCase.task === 'label') {
    const correct = normalizeBenchText(output) === normalizeBenchText(testCase.expectedLabel ?? '')
    return { score: Number(correct), valid: true, detail: correct ? 'exact label match' : 'label mismatch' }
  }

  const parsed = parseBenchJson(output)
  if (!parsed) return { score: 0, valid: false, detail: 'invalid JSON' }

  if (testCase.task === 'fields') {
    const expected = testCase.expected ?? {}
    const keys = Object.keys(expected)
    let correct = 0
    for (const key of keys) {
      const got = asString(parsed[key])
      const expectedValues = accepted(expected[key])
      if (expectedValues.some((value) => normalizedField(key, got) === normalizedField(key, value))) correct++
    }
    return {
      score: keys.length ? correct / keys.length : 0,
      valid: true,
      detail: `${correct}/${keys.length} fields exact after declared normalization`
    }
  }

  if (testCase.task === 'items') {
    const expected = testCase.expectedItems ?? []
    const raw = parsed.items
    const got = Array.isArray(raw)
      ? raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      : []
    const remaining = [...expected]
    let matches = 0
    for (const item of got) {
      const ix = remaining.findIndex((want) =>
        Object.entries(want).every(
          ([key, value]) => normalizedField(key, asString(item[key])) === normalizedField(key, value)
        )
      )
      if (ix >= 0) {
        matches++
        remaining.splice(ix, 1)
      }
    }
    const precision = got.length ? matches / got.length : expected.length ? 0 : 1
    const recall = expected.length ? matches / expected.length : 1
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 1
    return {
      score: f1,
      precision,
      recall,
      f1,
      valid: true,
      detail: `${matches}/${expected.length} expected items; ${got.length} returned`
    }
  }

  const summary = asString(parsed.summary)
  const facts = testCase.requiredFacts ?? []
  const covered = facts.filter((alternatives) =>
    alternatives.some((fact) => normalizeBenchText(summary).includes(normalizeBenchText(fact)))
  )
  const recall = facts.length ? covered.length / facts.length : 1
  return {
    score: recall,
    recall,
    valid: true,
    detail: `${covered.length}/${facts.length} required facts lexically covered`
  }
}

/** Character-level normalized Levenshtein similarity for output drift across repeated runs. */
export function outputSimilarity(a: string, b: string): number {
  const left = normalizeBenchText(a)
  const right = normalizeBenchText(b)
  if (left === right) return 1
  if (!left.length || !right.length) return 0
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(right.length + 1)
    current[0] = i
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length)
}

/**
 * 95% percentile interval for the macro mean, resampling documents with replacement
 * within each task family. The seeded generator makes a report exactly reproducible.
 */
export function stratifiedBootstrapMeanInterval(
  points: Array<{ task: string; score: number }>,
  resamples = 10_000,
  seed = 2026
): { lower: number; upper: number; resamples: number } {
  const groups = new Map<string, number[]>()
  for (const point of points) {
    if (!Number.isFinite(point.score)) continue
    const group = groups.get(point.task) ?? []
    group.push(point.score)
    groups.set(point.task, group)
  }
  const strata = [...groups.values()].filter((group) => group.length > 0)
  if (!strata.length) return { lower: 0, upper: 0, resamples: 0 }

  let state = seed >>> 0 || 1
  const random = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  const count = Math.max(100, Math.round(resamples))
  const means = new Array<number>(count)
  for (let draw = 0; draw < count; draw++) {
    let sum = 0
    let groupsSampled = 0
    for (const group of strata) {
      let groupSum = 0
      for (let i = 0; i < group.length; i++) groupSum += group[Math.floor(random() * group.length)]!
      sum += groupSum / group.length
      groupsSampled++
    }
    means[draw] = sum / groupsSampled
  }
  means.sort((a, b) => a - b)
  return {
    lower: means[Math.floor((count - 1) * 0.025)]!,
    upper: means[Math.ceil((count - 1) * 0.975)]!,
    resamples: count
  }
}
