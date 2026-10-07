import { describe, expect, test } from 'bun:test'
import { matchProject } from './intelligence'

const projects = [
  { id: 'inkfish', name: 'Inkfish' },
  { id: 'japan-trip', name: 'Japan trip' },
  { id: 'work', name: 'work' }
]

describe('matchProject', () => {
  test('exact, case-insensitive', () => {
    expect(matchProject('inkfish', projects)?.id).toBe('inkfish')
    expect(matchProject('JAPAN TRIP', projects)?.id).toBe('japan-trip')
  })
  test('containment either way', () => {
    expect(matchProject('Japan', projects)?.id).toBe('japan-trip')
    expect(matchProject('the work project', projects)?.id).toBe('work')
  })
  test('unknown or empty → null so the router falls back', () => {
    expect(matchProject('', projects)).toBeNull()
    expect(matchProject('gardening', projects)).toBeNull()
  })
})
