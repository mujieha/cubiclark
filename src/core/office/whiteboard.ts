// What the office's whiteboard shows (design §7: "the selected task's timeline"), as data: a short
// label, where the task is among planning, building, review and done, and how many times its model
// changed. Pure: the renderer only draws it. The full timeline is in the HUD panel.

import { timelineView, type StageState } from '../hud.js'
import type { Task } from '../types.js'

export interface WhiteboardModel {
  /** The task id, cut to the five characters that fit on the board. */
  label: string
  /** planning, building, review, done. */
  stages: StageState[]
  /** How many times the model changed along the timeline (drawn as that many dots, at most 4). */
  modelChanges: number
}

export const WHITEBOARD_LABEL_CHARS = 5
export const WHITEBOARD_MAX_DOTS = 4

export function whiteboardModel(task: Task | undefined): WhiteboardModel | undefined {
  if (!task) return undefined
  const view = timelineView(task)
  return {
    label: view.taskId.slice(0, WHITEBOARD_LABEL_CHARS),
    stages: view.stages.map((stage) => stage.state),
    modelChanges: Math.min(WHITEBOARD_MAX_DOTS, view.entries.filter((entry) => entry.modelChange !== undefined).length),
  }
}
