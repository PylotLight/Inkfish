import { describe, expect, test } from 'bun:test'
import {
  INTEL_BENCH_CASES,
  outputSimilarity,
  selectIntelBenchCases,
  scoreIntelBenchCase,
  stratifiedBootstrapMeanInterval
} from './intel-bench'

describe('document-processing benchmark scoring', () => {
  test('contains three versioned examples for each task family', () => {
    expect(INTEL_BENCH_CASES).toHaveLength(15)
    const counts = INTEL_BENCH_CASES.reduce<Record<string, number>>((all, item) => {
      all[item.task] = (all[item.task] ?? 0) + 1
      return all
    }, {})
    expect(Object.values(counts).sort()).toEqual([3, 3, 3, 3, 3])
    const vision = INTEL_BENCH_CASES.filter((item) => item.task === 'vision-fields')
    expect(vision).toHaveLength(3)
    expect(
      vision.every((item) => item.imagePaths?.length === 1 && item.imagePaths[0]?.startsWith('scripts/fixtures/'))
    ).toBe(true)
  })

  test('vision invoice fields use deterministic normalized scoring', () => {
    const item = INTEL_BENCH_CASES.find((x) => x.id === 'vision-invoice-001')!
    expect(
      scoreIntelBenchCase(
        item,
        JSON.stringify({
          supplier: 'NORTHSTAR Office Supply',
          invoice_number: 'ns 2048',
          issue_date: '14 October 2026',
          total: '$1,426.00',
          currency: 'nzd'
        })
      )
    ).toMatchObject({ score: 1, valid: true, detail: '5/5 fields exact after declared normalization' })
    expect(
      scoreIntelBenchCase(
        item,
        JSON.stringify({
          supplier: 'Northstar Office Supply',
          invoice_number: 'NS-2048',
          issue_date: '2026-10-14',
          total: '1426.01',
          currency: 'NZD'
        })
      ).score
    ).toBe(4 / 5)
  })

  test('selects vision cases only for the exact LFM3-VL model ID', () => {
    expect(selectIntelBenchCases('LiquidAI/LFM3-1.7B-GGUF:Q4_K_M').some((item) => item.task === 'vision-fields')).toBe(
      false
    )
    expect(selectIntelBenchCases('LiquidAI/LFM3-1.7B-ONNX').some((item) => item.task === 'vision-fields')).toBe(false)
    expect(
      selectIntelBenchCases('LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M').filter((item) => item.task === 'vision-fields')
    ).toHaveLength(3)
    expect(
      selectIntelBenchCases('LiquidAI/LFM3-VL-2B-ONNX').filter((item) => item.task === 'vision-fields')
    ).toHaveLength(3)
  })

  test('scores invoice fields after declared date and amount normalization', () => {
    const item = INTEL_BENCH_CASES.find((x) => x.id === 'invoice-fields-v1')!
    const result = scoreIntelBenchCase(
      item,
      JSON.stringify({
        supplier: 'Coastline Stationery Pty Ltd',
        invoice_number: 'CS-1842',
        issue_date: '21 September 2026',
        due_date: '2026-10-21',
        purchase_order: 'PO-739',
        currency: 'AUD',
        subtotal: '960',
        gst: 96,
        total: '$1,056.00'
      })
    )
    expect(result).toMatchObject({ score: 1, valid: true, detail: '9/9 fields exact after declared normalization' })
  })

  test('scores action items with precision and recall and penalizes invented work', () => {
    const item = INTEL_BENCH_CASES.find((x) => x.id === 'meeting-actions-v1')!
    const result = scoreIntelBenchCase(
      item,
      JSON.stringify({
        items: [
          { owner: 'Maya', action: 'Email the revised design to the team', due: '30/10/2026' },
          { owner: 'Theo', action: 'Compare quotes from two suppliers', due: '2026-11-02' },
          { owner: 'Someone', action: 'Book the launch venue', due: '' }
        ]
      })
    )
    expect(result).toMatchObject({ precision: 2 / 3, recall: 1, f1: 0.8, score: 0.8 })
  })

  test('requires an exact allowed classification label', () => {
    const item = INTEL_BENCH_CASES.find((x) => x.id === 'document-routing-v1')!
    expect(scoreIntelBenchCase(item, 'legal')).toMatchObject({ score: 1, valid: true })
    expect(scoreIntelBenchCase(item, 'probably legal')).toMatchObject({ score: 0, valid: true })
  })

  test('measures summary coverage by required fact phrases without a judge', () => {
    const item = INTEL_BENCH_CASES.find((x) => x.id === 'grounded-summary-v1')!
    const full = scoreIntelBenchCase(
      item,
      JSON.stringify({
        summary:
          'Atlas Logistics plans cold-chain monitoring across 12 depots from November 2026, beginning in Geelong.'
      })
    )
    const partial = scoreIntelBenchCase(
      item,
      JSON.stringify({ summary: 'Atlas Logistics plans a cold-chain project in Geelong.' })
    )
    expect(full.score).toBe(1)
    expect(partial).toMatchObject({ score: 2 / 5, recall: 2 / 5 })
  })

  test('repeatability similarity ignores harmless case and punctuation changes', () => {
    expect(outputSimilarity('Invoice: CS-1842.', 'invoice cs 1842')).toBe(1)
    expect(outputSimilarity('short', 'longer text')).toBeLessThan(0.5)
  })

  test('document-stratified bootstrap interval is seeded and exact for constant scores', () => {
    const points = [
      { task: 'fields', score: 0.75 },
      { task: 'fields', score: 0.75 },
      { task: 'summary', score: 0.75 },
      { task: 'summary', score: 0.75 }
    ]
    const interval = stratifiedBootstrapMeanInterval(points, 1000, 17)
    expect(interval).toEqual({ lower: 0.75, upper: 0.75, resamples: 1000 })
    expect(stratifiedBootstrapMeanInterval(points, 1000, 17)).toEqual(interval)
  })
})
