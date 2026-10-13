import { expect, test, tier } from 'claude-code/testing'
import { bashMarkdown } from './bash'

tier('user')

test('bash input alone names the command, fencing multiline commands', () => {
  expect(bashMarkdown('<bash-input>ls</bash-input>')).toBe('Ran `ls`')
  expect(bashMarkdown('<bash-input>ls\npwd</bash-input>')).toBe('Ran\n\n```\nls\npwd\n```')
  expect(bashMarkdown('<bash-input>echo `pwd`</bash-input>')).toBe('Ran `` echo `pwd` ``')
})

test('bash output alone is fenced, with empty stderr omitted', () => {
  expect(bashMarkdown('<bash-stdout>Applications\nDesktop</bash-stdout>'))
    .toBe('```\nApplications\nDesktop\n```')
  expect(bashMarkdown('<bash-stdout>Applications\n</bash-stdout><bash-stderr></bash-stderr>'))
    .toBe('```\nApplications\n```')
})

test('bash input and output together remain one readable row', () => {
  expect(bashMarkdown('<bash-input>ls</bash-input>\n\n\n<bash-stdout>Applications</bash-stdout><bash-stderr></bash-stderr>'))
    .toBe('Ran `ls`\n\n```\nApplications\n```')
})

test('nonempty stderr is labelled and fenced', () => {
  expect(bashMarkdown('<bash-stdout>out</bash-stdout><bash-stderr>permission denied</bash-stderr>'))
    .toBe('```\nout\n```\n\nStderr:\n\n```\npermission denied\n```')
  expect(bashMarkdown('<bash-stderr>failure</bash-stderr>')).toBe('Stderr:\n\n```\nfailure\n```')
})

test('backticks cannot close an output or command fence', () => {
  expect(bashMarkdown('<bash-stdout>```\ntext\n````</bash-stdout><bash-stderr>```</bash-stderr>'))
    .toBe('`````\n```\ntext\n````\n`````\n\nStderr:\n\n````\n```\n````')
  expect(bashMarkdown('<bash-input>echo ```\npwd</bash-input>')).toBe('Ran\n\n````\necho ```\npwd\n````')
})

test('unrelated prose, partial tags, and other text are untouched', () => {
  for (const text of ['Mention <bash-input> in prose.', '<bash-input>ls</bash-input> is an example.',
    'Example: <bash-input>ls</bash-input>', '<bash-input>unfinished', 'plain text'])
    expect(bashMarkdown(text)).toBe(text)
})
