import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'burn-meter'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }

/** A session that has spent $2.50 and used 30% of its five-hour window, and another mod drawing in the band. */
function engineBeneath(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }], cost: { usd: 2.5 } } }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.blit', () => ({ value: {} }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>another mod's band</Text>
  })
  return clock
}

async function bandText($: Engine) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('|')
  await ui.unmount()
  return texts
}

test("the band shares the prompt: another mod's band stays under it", async ($, on) => {
  const clock = engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(1000)
  const text = await bandText($)
  expect(text).toContain('BURN')
  expect(text).toContain("another mod's band")
  expect(text.indexOf('BURN')).toBeLessThan(text.indexOf("another mod's band"))
})

test('/burn hide leaves the band to the other mods', async ($, on) => {
  const clock = engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(1000)
  await $.command.run({ command: 'burn', args: 'hide', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const text = await bandText($)
  expect(text).not.toContain('BURN')
  expect(text).toContain("another mod's band")
})
