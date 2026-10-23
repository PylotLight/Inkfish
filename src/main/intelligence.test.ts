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
  test('no loose containment: partial names are not a match', () => {
    expect(matchProject('Japan', projects)).toBeNull()
    expect(matchProject('the work project', projects)).toBeNull()
    expect(matchProject('  Inkfish ', projects)?.id).toBe('inkfish')
  })
  test('unknown or empty → null so the router falls back', () => {
    expect(matchProject('', projects)).toBeNull()
    expect(matchProject('gardening', projects)).toBeNull()
  })
})
