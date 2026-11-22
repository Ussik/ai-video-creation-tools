import { z } from 'zod'
import { one, run, now } from '../../infrastructure/database/db.js'

/**
 * Conversation Mode Manager
 *
 * Manages conversation modes to balance user exploration and system guidance.
 *
 * Based on industry best practices from:
 * - ChatGPT/Claude: Default to chat mode
 * - Notion AI: Explicit mode switching
 * - Cursor: Suggestion-based interaction
 * - Gamma AI: Progressive phases
 *
 * Design Principles:
 * 1. Mixed Initiative: Balance user control and system guidance
 * 2. Layer Separation: Distinguish discussion from execution
 * 3. Explicit Triggers: Only execute with clear signals
 * 4. User Control: User should feel in control of the pace
 */

// ===== Mode Definitions =====

export type ConversationModeType = 'discussion' | 'planning' | 'execution'

export const conversationModeSchema = z.object({
  current: z.enum(['discussion', 'planning', 'execution']),
  entered_at: z.string(),

  // Configuration for current mode
  config: z.object({
    // Whether to recognize execution intent
    enable_intent_recognition: z.boolean(),

    // Whether to provide suggestions
    provide_suggestions: z.boolean(),

    // Whether to require confirmation before execution
    require_confirmation: z.boolean(),

    // Whether system can auto-switch to another mode
    allow_auto_switch: z.boolean(),
  }),

  // Hints for UI display
  hints: z.object({
    status: z.string(),              // "自由讨论中"
    description: z.string(),         // "随时说出你的想法"
    available_actions: z.array(z.string()),  // ["切换到规划模式", "开始生成"]
  }),
})

export type ConversationMode = z.infer<typeof conversationModeSchema>

// ===== Mode Configurations =====

const MODE_CONFIGS: Record<ConversationModeType, ConversationMode['config']> = {
  discussion: {
    enable_intent_recognition: false,  // Discussion mode: don't recognize execution intent
    provide_suggestions: true,         // Provide suggestions and analysis
    require_confirmation: false,       // No confirmation needed for discussion
    allow_auto_switch: false,          // Don't auto-switch to execution
  },

  planning: {
    enable_intent_recognition: true,   // Planning mode: recognize intent but don't execute
    provide_suggestions: true,         // Provide planning suggestions
    require_confirmation: false,       // Planning doesn't need confirmation
    allow_auto_switch: false,          // Require explicit trigger to execute
  },

  execution: {
    enable_intent_recognition: true,   // Execution mode: recognize and execute
    provide_suggestions: false,        // Focus on execution, not suggestions
    require_confirmation: true,        // Confirm before expensive operations
    allow_auto_switch: false,          // Stay in execution until task completes
  },
}

const MODE_HINTS: Record<ConversationModeType, ConversationMode['hints']> = {
  discussion: {
    status: '💬 讨论模式',
    description: '自由讨论中，随时说出你的想法',
    available_actions: ['切换到规划模式', '直接开始生成'],
  },

  planning: {
    status: '📝 规划模式',
    description: '整理思路中，准备好了可以开始生成',
    available_actions: ['返回讨论', '开始生成'],
  },

  execution: {
    status: '⚙️ 生成模式',
    description: '正在生成内容...',
    available_actions: ['返回讨论'],
  },
}

// ===== Trigger Signal Detection =====

/**
 * Check if message has explicit execution trigger
 *
 * Execution triggers:
 * - User clicked explicit button (explicit_workflow exists)
 * - User used explicit execution verbs: "生成", "创建", "开始"
 * - User confirmed pending plan: "好的", "开始吧"
 */
export function hasExplicitExecutionTrigger(
  message: string,
  context: {
    explicit_workflow?: unknown
    pending_plan?: unknown
  }
): boolean {
  // 1. User clicked explicit button
  if (context.explicit_workflow) {
    return true
  }

  // 2. User used explicit execution verbs
  const executionVerbs = ['生成', '创建', '开始', '写', '做']
  const hasVerb = executionVerbs.some(verb => message.includes(verb))

  if (hasVerb) {
    // But exclude questions and hypotheticals
    if (isQuestion(message)) return false
    if (isHypothetical(message)) return false

    return true
  }

  // 3. User confirmed pending plan
  if (context.pending_plan && isConfirmation(message)) {
    return true
  }

  return false
}

/**
 * Check if message has planning signal
 *
 * Planning signals:
 * - "我们来规划一下"
 * - "整理一下思路"
 * - "梳理一下"
 */
export function hasPlanningSignal(message: string): boolean {
  const planningKeywords = ['规划', '整理', '梳理', '总结一下']
  return planningKeywords.some(keyword => message.includes(keyword))
}

/**
 * Check if message is hypothetical (exploration)
 *
 * Hypothetical indicators:
 * - "我想..." (I'm thinking about)
 * - "可能..." (Maybe)
 * - "如果..." (If)
 * - "或者..." (Or)
 */
function isHypothetical(message: string): boolean {
  const hypotheticalWords = ['想', '可能', '如果', '也许', '或者', '是不是', '会不会']
  return hypotheticalWords.some(word => message.includes(word))
}

/**
 * Check if message is a question
 */
function isQuestion(message: string): boolean {
  return message.includes('?') ||
         message.includes('？') ||
         message.includes('吗') ||
         message.includes('呢')
}

/**
 * Check if message is confirmation
 */
function isConfirmation(message: string): boolean {
  const confirmationWords = ['好的', '可以', '开始吧', '就这样', '确认', '是的', '对']
  return confirmationWords.some(word => message.trim() === word || message.includes(word))
}

// ===== Mode Manager =====

export class ConversationModeManager {
  /**
   * Get current conversation mode for a project
   */
  getMode(projectId: string, conversationId?: string): ConversationMode {
    if (!conversationId) {
      return this.getDefaultMode()
    }

    const row = one<{ mode: string; entered_at: string }>(
      'SELECT mode, entered_at FROM script_conversation_modes WHERE conversation_id=?',
      conversationId
    )

    if (!row) {
      return this.getDefaultMode()
    }

    const modeType = row.mode as ConversationModeType
    return {
      current: modeType,
      entered_at: row.entered_at,
      config: MODE_CONFIGS[modeType],
      hints: MODE_HINTS[modeType],
    }
  }

  /**
   * Get default mode (discussion)
   */
  getDefaultMode(): ConversationMode {
    return {
      current: 'discussion',
      entered_at: now(),
      config: MODE_CONFIGS.discussion,
      hints: MODE_HINTS.discussion,
    }
  }

  /**
   * Switch to a new mode
   */
  switchMode(
    conversationId: string,
    newMode: ConversationModeType,
    reason: string
  ): ConversationMode {
    const timestamp = now()

    run(`INSERT INTO script_conversation_modes (conversation_id, mode, entered_at, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET mode=excluded.mode, entered_at=excluded.entered_at, reason=excluded.reason, updated_at=excluded.updated_at`,
      conversationId, newMode, timestamp, reason, timestamp
    )

    return {
      current: newMode,
      entered_at: timestamp,
      config: MODE_CONFIGS[newMode],
      hints: MODE_HINTS[newMode],
    }
  }

  /**
   * Determine mode based on message and context
   *
   * This is called before intent recognition to decide whether to recognize intent
   */
  determineMode(
    message: string,
    currentMode: ConversationMode,
    context: {
      explicit_workflow?: unknown
      pending_plan?: unknown
    }
  ): { mode: ConversationModeType; should_switch: boolean; reason?: string } {
    // Check for explicit execution trigger
    if (hasExplicitExecutionTrigger(message, context)) {
      return {
        mode: 'execution',
        should_switch: currentMode.current !== 'execution',
        reason: 'Explicit execution trigger detected',
      }
    }

    // Check for planning signal
    if (hasPlanningSignal(message)) {
      return {
        mode: 'planning',
        should_switch: currentMode.current !== 'planning',
        reason: 'Planning signal detected',
      }
    }

    // In execution mode, auto-return to discussion after task completes
    if (currentMode.current === 'execution' && !context.explicit_workflow) {
      return {
        mode: 'discussion',
        should_switch: true,
        reason: 'Task completed, returning to discussion',
      }
    }

    // Otherwise, stay in current mode
    return {
      mode: currentMode.current,
      should_switch: false,
    }
  }

  /**
   * Check if should recognize intent in current mode
   */
  shouldRecognizeIntent(mode: ConversationMode, message: string, context: any): boolean {
    // Discussion mode: only recognize intent if explicit trigger exists
    if (mode.current === 'discussion') {
      return hasExplicitExecutionTrigger(message, context)
    }

    // Planning and execution modes: recognize intent
    return mode.config.enable_intent_recognition
  }
}

// ===== Singleton Instance =====

export const conversationModeManager = new ConversationModeManager()
