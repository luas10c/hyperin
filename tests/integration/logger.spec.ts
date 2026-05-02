import { describe, expect, jest, test } from '@jest/globals'

import { createLogger, type LoggerEvent } from '#/logger'

describe('logger', () => {
  test('emits application logs through configured transports', () => {
    const events: LoggerEvent[] = []
    const logger = createLogger({
      kind: 'audit',
      level: 'info',
      transports: [
        ({ event }) => {
          events.push(event)
        }
      ]
    })

    logger.trace('trace hidden')
    logger.info('user created', { userId: '123' })
    logger.warn('cache warmed')
    logger.debug('debug hidden')
    logger.error('payment failed', { orderId: 'ord-1' })
    logger.fatal('worker crashed', { workerId: 'wk-1' })

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'audit',
        level: 'info',
        message: 'user created',
        attributes: { userId: '123' }
      }),
      expect.objectContaining({
        kind: 'audit',
        level: 'warn',
        message: 'cache warmed',
        attributes: {}
      }),
      expect.objectContaining({
        kind: 'audit',
        level: 'error',
        message: 'payment failed',
        attributes: { orderId: 'ord-1' }
      }),
      expect.objectContaining({
        kind: 'audit',
        level: 'fatal',
        message: 'worker crashed',
        attributes: { workerId: 'wk-1' }
      })
    ])
  })

  test('does not emit application logs when disabled', () => {
    const transport = jest.fn()
    const logger = createLogger({
      enabled: false,
      level: 'info',
      transports: [transport]
    })

    logger.trace('trace hidden')
    logger.info('user created', { userId: '123' })
    logger.warn('cache warmed')
    logger.error('payment failed', { orderId: 'ord-1' })
    logger.fatal('worker crashed', { workerId: 'wk-1' })
    expect(transport).not.toHaveBeenCalled()
  })

  test('uses stdout transport by default when no transports are provided', () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const logger = createLogger({ kind: 'audit', level: 'info' })
      logger.info('default transport')

      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(String(writeSpy.mock.calls[0]?.[0])).toContain('default transport')
    } finally {
      writeSpy.mockRestore()
    }
  })
})
