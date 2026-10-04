// What the person at the page feels: long tasks (the main thread blocked for over 50 ms; a page that
// freezes has them by the second) and frames per second, measured while the World is pushed as the
// real server pushes it: once a second, every push laying out the office again, baking its static
// picture again and rebuilding the table.

import type { Page } from '@playwright/test'
import type { World } from '../../src/core/types.js'
import { pushWorld } from './fake-world.js'

interface LongTask {
  start: number
  duration: number
}

/** Runs in the page before any of its scripts (`page.addInitScript(LONG_TASKS)`, before the page is
 * opened): every long task is remembered, buffered ones included. */
export const LONG_TASKS = (): void => {
  const w = window as unknown as { __cubiclarkLongTasks: LongTask[] }
  w.__cubiclarkLongTasks = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__cubiclarkLongTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // long tasks are not reported here: the test then sees none, and its fps check still holds
  }
}

/** performance.now() in the page. */
export async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now())
}

/** The durations, in ms, of the long tasks that started at or after `sinceMs` (page time), longest first. */
export async function longTasksSince(page: Page, sinceMs: number): Promise<number[]> {
  const tasks = await page.evaluate(() => (window as unknown as { __cubiclarkLongTasks?: LongTask[] }).__cubiclarkLongTasks ?? [])
  return tasks
    .filter((task) => task.start >= sinceMs)
    .map((task) => Math.round(task.duration))
    .sort((a, b) => b - a)
}

/** Pushes `world` once a second for `seconds`, its clock moving on a second each time. */
export async function pushEverySecond(page: Page, world: World, seconds: number): Promise<void> {
  const startMs = Date.parse(world.clock)
  for (let second = 0; second < seconds; second++) {
    await pushWorld(page, { ...world, clock: new Date(startMs + second * 1000).toISOString() })
    await page.waitForTimeout(1000)
  }
}

/** The text canvas's backing store, in device pixels, as text ("2304x10368"): the words are on their own canvas. */
export async function textCanvasSize(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.office-text')
    return canvas ? `${canvas.width}x${canvas.height}` : 'none'
  })
}

/** The canvas's backing store, in device pixels, as text ("2304x10368"). */
export async function canvasSize(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.office-canvas')
    return canvas ? `${canvas.width}x${canvas.height}` : 'none'
  })
}
