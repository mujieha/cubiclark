// What the office's whiteboard shows (design §7: "the selected task's timeline"), as data: a label,
// where the task is among planning, building, review and done, and how many times its model changed.
// Pure: the renderer only draws it. The full timeline is in the HUD panel.

import { timelineView, type StageState } from '../hud.js'
import type { Task, TaskPhase } from '../types.js'
import { fitText } from './text.js'

export interface WhiteboardModel {
  /** The whole task id: what fits of it is decided by `whiteboardLabel`, where the width is known. */
  label: string
  /** The task's phase, whose word stands in for an id too long to show. */
  phase?: TaskPhase
  /** planning, building, review, done. */
  stages: StageState[]
  /** How many times the model changed along the timeline (drawn as that many dots, at most 4). */
  modelChanges: number
}

export const WHITEBOARD_MAX_DOTS = 4
/** A cut id is shown only with at least this many of its characters: five characters of
 * `mujieha-site-appcast-source` say nothing, so the phase word is shown instead (the panel has the id). */
export const WHITEBOARD_MIN_LABEL_CHARS = 8

export function whiteboardModel(task: Task | undefined): WhiteboardModel | undefined {
  if (!task) return undefined
  const view = timelineView(task)
  return {
    label: view.taskId,
    ...(task.phase === undefined ? {} : { phase: task.phase }),
    stages: view.stages.map((stage) => stage.state),
    modelChanges: Math.min(WHITEBOARD_MAX_DOTS, view.entries.filter((entry) => entry.modelChange !== undefined).length),
  }
}

/** The word on the board for a room `maxWidth` wide, in the first of these ways that fits: the whole
 * task id; the id cut with an ellipsis, when at least WHITEBOARD_MIN_LABEL_CHARS of it show; the task's
 * phase word; nothing. `measure` is the width of a text in the board's font. */
export function whiteboardLabel(model: WhiteboardModel, maxWidth: number, measure: (text: string) => number): string {
  if (!(maxWidth > 0)) return ''
  if (model.label !== '' && measure(model.label) <= maxWidth) return model.label
  const cut = fitText(model.label, maxWidth, measure)
  if (cut.endsWith('…') && [...cut].length - 1 >= WHITEBOARD_MIN_LABEL_CHARS) return cut
  if (model.phase !== undefined && measure(model.phase) <= maxWidth) return model.phase
  return ''
}
