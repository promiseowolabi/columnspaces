/**
 * Exercise-kind metadata (icon + label) shared by LessonRow and the lesson page.
 */

import { Activity, BookOpen, Calculator, FlaskConical, Gavel, HelpCircle, Terminal } from 'lucide-react'
import type { ExerciseKind } from '@/data/lessons/types'

export const EXERCISE_META: Record<ExerciseKind, { icon: typeof Activity; label: string }> = {
  sim: { icon: Activity, label: 'simulator' },
  code: { icon: Terminal, label: 'forge lab' },
  quiz: { icon: HelpCircle, label: 'quiz' },
  read: { icon: BookOpen, label: 'guided read' },
  'quiz+sim': { icon: Activity, label: 'quiz + sim' },
  'read+quiz': { icon: BookOpen, label: 'read + quiz' },
  'desk+quiz': { icon: Calculator, label: 'desk + quiz' },
  'lab+quiz': { icon: FlaskConical, label: 'lab + quiz' },
  room: { icon: Gavel, label: 'design review' },
}
