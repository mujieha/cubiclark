// Keys as a pure reducer: q, Tab, the arrows, l. No terminal needed.

import { describe, expect, test } from 'vitest'
import { INITIAL_UI, keyOf, reconcileUi, reduceKey, type KeyContext, type TuiUi } from '../src/core/tui/ui.js'

const ctx: KeyContext = {
  officeOrder: ['c', 'a', 'b', 'd'],
  listOrder: ['a', 'b', 'c', 'd'],
  officeShown: true,
  logRows: 50,
  logPage: 10,
  listPage: 2,
}
const press = (ui: TuiUi, ...keys: Parameters<typeof reduceKey>[1][]): TuiUi => keys.reduce((state, key) => reduceKey(state, key, ctx).ui, ui)

describe('keyOf', () => {
  test('names the keys we use', () => {
    expect(keyOf('q', { name: 'q' })).toBe('quit')
    expect(keyOf('\u0003', { name: 'c', ctrl: true })).toBe('quit')
    expect(keyOf(undefined, { name: 'c', ctrl: true })).toBe('quit')
    expect(keyOf('\t', { name: 'tab' })).toBe('tab')
    expect(keyOf(undefined, { name: 'tab', shift: true })).toBe('backtab')
    for (const name of ['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'escape'] as const) expect(keyOf(undefined, { name })).toBe(name)
    expect(keyOf('l', { name: 'l' })).toBe('office')
    expect(keyOf('L', { name: 'l', shift: true })).toBe('office')
  })

  test('ignores everything else', () => {
    expect(keyOf('x', { name: 'x' })).toBeUndefined()
    expect(keyOf(undefined, undefined)).toBeUndefined()
    expect(keyOf('\u0011', { name: 'q', ctrl: true })).toBeUndefined()
    expect(keyOf('1', { name: '1' })).toBeUndefined()
  })
})

describe('quit', () => {
  test('q quits and changes nothing else', () => {
    expect(reduceKey(INITIAL_UI, 'quit', ctx)).toEqual({ ui: INITIAL_UI, quit: true })
    expect(reduceKey(INITIAL_UI, 'down', ctx).quit).toBe(false)
  })
})

describe('Tab', () => {
  test('cycles office, list, log, office', () => {
    const office: TuiUi = { ...INITIAL_UI, focus: 'office' }
    expect(press(office, 'tab').focus).toBe('list')
    expect(press(office, 'tab', 'tab').focus).toBe('log')
    expect(press(office, 'tab', 'tab', 'tab').focus).toBe('office')
  })

  test('skips the office when it is not on screen', () => {
    const noOffice = { ...ctx, officeShown: false }
    const list = reduceKey(INITIAL_UI, 'tab', noOffice).ui
    expect(list.focus).toBe('log')
    expect(reduceKey(list, 'tab', noOffice).ui.focus).toBe('list')
    expect(reduceKey({ ...INITIAL_UI, focus: 'log' }, 'backtab', noOffice).ui.focus).toBe('list')
    expect(reduceKey(INITIAL_UI, 'backtab', noOffice).ui.focus).toBe('log')
  })

  test('Shift+Tab goes the other way', () => {
    expect(press({ ...INITIAL_UI, focus: 'office' }, 'backtab').focus).toBe('log')
    expect(press(INITIAL_UI, 'backtab').focus).toBe('office')
  })
})

describe('arrows in the list', () => {
  test('down with nothing selected selects the first, up the last', () => {
    expect(press(INITIAL_UI, 'down').selectedId).toBe('a')
    expect(press(INITIAL_UI, 'up').selectedId).toBe('d')
    expect(press(INITIAL_UI, 'right').selectedId).toBe('a')
    expect(press(INITIAL_UI, 'left').selectedId).toBe('d')
  })

  test('moves one at a time and does not wrap at either end', () => {
    expect(press(INITIAL_UI, 'down', 'down', 'down').selectedId).toBe('c')
    expect(press(INITIAL_UI, 'down', 'down', 'down', 'down', 'down', 'down').selectedId).toBe('d')
    expect(press(INITIAL_UI, 'down', 'up', 'up').selectedId).toBe('a')
  })

  test('PageUp and PageDown move by a page; Home and End go to the ends', () => {
    expect(press(INITIAL_UI, 'down', 'pagedown').selectedId).toBe('c')
    expect(press(INITIAL_UI, 'down', 'pagedown', 'pagedown', 'pagedown').selectedId).toBe('d')
    expect(press(INITIAL_UI, 'up', 'pageup').selectedId).toBe('b')
    expect(press(INITIAL_UI, 'end').selectedId).toBe('d')
    expect(press(INITIAL_UI, 'end', 'home').selectedId).toBe('a')
  })

  test('an empty list changes nothing', () => {
    const empty = { ...ctx, listOrder: [], officeOrder: [] }
    expect(reduceKey(INITIAL_UI, 'down', empty).ui).toBe(INITIAL_UI)
  })
})

describe('arrows in the office', () => {
  test('follow the office\'s reading order, not the list\'s', () => {
    const office: TuiUi = { ...INITIAL_UI, focus: 'office' }
    expect(press(office, 'down').selectedId).toBe('c')
    expect(press(office, 'down', 'down').selectedId).toBe('a')
  })

  test('an office that is not shown moves through the list', () => {
    expect(reduceKey({ ...INITIAL_UI, focus: 'office' }, 'down', { ...ctx, officeShown: false }).ui.selectedId).toBe('a')
  })
})

describe('arrows in the log', () => {
  const log: TuiUi = { ...INITIAL_UI, focus: 'log' }

  test('up scrolls back, down forward, never below zero', () => {
    expect(press(log, 'up', 'up').logScroll).toBe(2)
    expect(press(log, 'up', 'up', 'down').logScroll).toBe(1)
    expect(press(log, 'down').logScroll).toBe(0)
  })

  test('never past the oldest line', () => {
    const many = Array.from({ length: 100 }, () => 'up' as const)
    expect(press(log, ...many).logScroll).toBe(40)
  })

  test('PageUp and PageDown move a page; Home goes to the oldest and End back to the newest', () => {
    expect(press(log, 'pageup').logScroll).toBe(10)
    expect(press(log, 'pageup', 'pageup', 'pagedown').logScroll).toBe(10)
    expect(press(log, 'home').logScroll).toBe(40)
    expect(press(log, 'home', 'end').logScroll).toBe(0)
  })

  test('a log shorter than its page does not scroll', () => {
    expect(reduceKey(log, 'up', { ...ctx, logRows: 3 }).ui.logScroll).toBe(0)
  })

  test('does not change the selection', () => {
    expect(press({ ...log, selectedId: 'b' }, 'down', 'up', 'home').selectedId).toBe('b')
  })
})

describe('l and Esc', () => {
  test('l turns the office off and on', () => {
    expect(press(INITIAL_UI, 'office').officeOn).toBe(false)
    expect(press(INITIAL_UI, 'office', 'office').officeOn).toBe(true)
  })

  test('turning the office off while it has the focus moves the focus to the list', () => {
    expect(press({ ...INITIAL_UI, focus: 'office' }, 'office').focus).toBe('list')
    expect(press({ ...INITIAL_UI, focus: 'log' }, 'office').focus).toBe('log')
  })

  test('Esc clears the selection', () => {
    expect(press({ ...INITIAL_UI, selectedId: 'a' }, 'escape').selectedId).toBeUndefined()
    expect(reduceKey(INITIAL_UI, 'escape', ctx).ui).toBe(INITIAL_UI)
  })
})

describe('reconcileUi', () => {
  test('drops a selection that left the view', () => {
    const ui = { ...INITIAL_UI, selectedId: 'gone' }
    expect(reconcileUi(ui, new Set(['a']), true).selectedId).toBeUndefined()
    expect(reconcileUi({ ...INITIAL_UI, selectedId: 'a' }, new Set(['a']), true).selectedId).toBe('a')
  })

  test('moves the focus off an office that is not on screen', () => {
    expect(reconcileUi({ ...INITIAL_UI, focus: 'office' }, new Set(), false).focus).toBe('list')
  })

  test('returns the same object when nothing changes', () => {
    expect(reconcileUi(INITIAL_UI, new Set(), true)).toBe(INITIAL_UI)
  })
})
