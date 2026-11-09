/** Installer presentation: a styled gutter on an interactive terminal, the original plain lines otherwise. */
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

const PATH_WIDTH = 56;
const SPIN_FRAMES = ['◒', '◐', '◓', '◑'];
const SPIN_MS = 80;
const LOGO = [
  ['█▀▀', '█▀█', '█▀▄', '█', '█▀▀', '█▀▀', '█ █', '█▀▀', '█▀▀'],
  ['█  ', '█ █', '█ █', '█', '▀▀█', '█  ', '█ █', '▀▀█', '▀▀█'],
  ['▀▀▀', '▀▀▀', '▀▀ ', '▀', '▀▀▀', '▀▀▀', '▀▀▀', '▀▀▀', '▀▀▀'],
];
const PREFIX_LETTERS = 2;
const GRADIENT = [[91, 140, 255], [167, 139, 250], [240, 171, 252]];

export const styled = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (styled ? `\x1b[${code}m${text}\x1b[0m` : text);
export const tone = {
  dim: text => paint('2', text), bold: text => paint('1', text), cyan: text => paint('36', text),
  green: text => paint('32', text), yellow: text => paint('33', text), red: text => paint('31', text),
  gray: text => paint('90', text),
};
const bar = () => tone.gray('│');
const write = text => process.stderr.write(text);

/** Display width that counts CJK and fullwidth characters as two terminal columns. */
export function text_width(text) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, '')) {
    const code = char.codePointAt(0);
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
  }
  return width;
}

/** Shorten a path for display: home becomes ~ and long middles collapse to …, keeping both ends readable. */
export function short_path(path, max = PATH_WIDTH) {
  const home = homedir();
  const value = path && path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path || '';
  if (value.length <= max) return value;
  const parts = value.split(/([\\/])/);
  const separator = parts[1] || sep;
  const names = parts.filter((_, index) => index % 2 === 0);
  return [...names.slice(0, 2), '…', ...names.slice(-2)].join(separator);
}

/** Pad a label to a display width so mixed Chinese and Latin columns line up. */
export const pad = (text, width) => text + ' '.repeat(Math.max(0, width - text_width(text)));

/** Colour one wordmark row along a left-to-right gradient; the "co" prefix stays neutral. */
function logo_row(letters) {
  const prefix = letters.slice(0, PREFIX_LETTERS).join(' ');
  const rest = `${letters.slice(PREFIX_LETTERS).join(' ')}`;
  const chars = [...rest];
  const shade = index => {
    const position = (index / Math.max(1, chars.length - 1)) * (GRADIENT.length - 1);
    const [from, to] = [GRADIENT[Math.floor(position)], GRADIENT[Math.ceil(position)]];
    const mix = position - Math.floor(position);
    return from.map((value, channel) => Math.round(value + (to[channel] - value) * mix)).join(';');
  };
  return `${paint('38;2;122;127;138', prefix)} ${chars.map((char, index) => (char === ' ' ? char : paint(`38;2;${shade(index)}`, char))).join('')}`;
}

/** Print the wordmark and open the gutter; a nested setup run skips it. */
export function intro(title, version, tagline) {
  if (!styled || process.env.CODISCUSS_TUI_NESTED) return;
  write(`\n${LOGO.map(row => `   ${logo_row(row)}`).join('\n')}\n`);
  write(`   ${tone.dim(`${tagline} · v${version}`)}\n\n${tone.gray('┌')}  ${tone.bold(title)}\n${bar()}\n`);
}

/** Print a finished step with optional detail lines; plain mode leaves output to the caller. */
export function step(title, lines = [], mark = tone.green('◇')) {
  if (!styled) return;
  write(`${mark}  ${title}\n${lines.map(line => `${bar()}  ${line}\n`).join('')}${bar()}\n`);
}

/** Animate a step while asynchronous work runs; synchronous work simply shows the first frame. */
export function spinner(title) {
  if (!styled) return { done: () => {}, fail: () => {} };
  let frame = 0;
  const render = () => write(`\r\x1b[2K${tone.cyan(SPIN_FRAMES[frame++ % SPIN_FRAMES.length])}  ${title}${tone.dim('…')}`);
  render();
  const timer = setInterval(render, SPIN_MS);
  const clear = () => { clearInterval(timer); write('\r\x1b[2K'); };
  return {
    done: (next = title, lines = []) => { clear(); step(next, lines); },
    fail: message => { clear(); step(tone.red(title), [tone.red(message)], tone.red('■')); },
  };
}

/** Ask one free-text question inside the gutter, falling back to a plain prompt. */
export async function ask(question, hint = '') {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!styled) return await prompt.question(`${question}${hint}：`);
    write(`${tone.cyan('◆')}  ${question.split('\n').join(`\n${bar()}  `)}\n`);
    const answer = await prompt.question(`${bar()}  ${tone.dim(hint)} ${tone.cyan('›')} `);
    write(`${bar()}\n`);
    return answer;
  } finally { prompt.close(); }
}

/** Draw one checkbox row; disabled rows are dimmed and cannot be focused. */
function checkbox_row(item, focused, checked) {
  const pointer = focused ? tone.cyan('›') : ' ';
  if (item.disabled) return `${bar()} ${pointer} ${tone.gray(`○ ${item.label}`)}  ${tone.gray(item.hint)}`;
  const box = checked ? tone.green('◼') : tone.dim('◻');
  return `${bar()} ${pointer} ${box} ${focused ? tone.bold(item.label) : item.label}  ${tone.dim(item.hint)}`;
}

/**
 * Render a terminal checkbox list: arrows move, space toggles, enter confirms, Ctrl+C cancels.
 * @param {{label: string, hint: string, checked: boolean, disabled: boolean}[]} items
 * @returns {Promise<boolean[]>} The checked state of every item.
 */
export function checkbox_prompt(message, items, input = process.stdin, output = process.stderr) {
  const checked = items.map(item => item.checked && !item.disabled);
  const width = Math.max(...items.map(item => text_width(item.label)));
  const rows = items.map(item => ({ ...item, label: pad(item.label, width) }));
  let cursor = Math.max(0, items.findIndex(item => !item.disabled)), drawn = 0;
  const move = offset => {
    for (let next = cursor + offset; next >= 0 && next < items.length; next += offset) {
      if (!items[next].disabled) { cursor = next; return; }
    }
  };
  const draw = (lines) => {
    if (drawn) output.write(`\x1b[${drawn}A`);
    output.write(`${lines.map(line => `\x1b[2K${line}`).join('\n')}\n`);
    if (lines.length < drawn) output.write(`\x1b[J`);
    drawn = lines.length;
  };
  const active = () => [`${tone.cyan('◆')}  ${message}`, ...rows.map((item, index) => checkbox_row(item, index === cursor, checked[index])),
    `${tone.gray('└')}  ${tone.dim('↑↓ 移动 · 空格 勾选 · 回车 确认')}`];
  return new Promise((done, fail) => {
    const finish = error => {
      input.off('keypress', on_key);
      input.setRawMode(false);
      input.pause();
      const chosen = items.filter((_, index) => checked[index]).map(item => item.label).join('、') || '不接入软件，只配置网站';
      draw(error ? [`${tone.red('■')}  ${message}`, `${bar()}  ${tone.dim('已取消')}`] : [`${tone.green('◇')}  ${message}`, `${bar()}  ${tone.dim(chosen)}`, bar()]);
      output.write('\x1b[?25h');
      if (error) fail(error); else done(checked);
    };
    const on_key = (_text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('已取消安装选择'));
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (key.name === 'space' && !items[cursor]?.disabled) checked[cursor] = !checked[cursor];
      else if (key.name === 'return' || key.name === 'enter') return finish();
      draw(active());
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', on_key);
    output.write('\x1b[?25l');
    draw(active());
  });
}

/** A group's mark from how many of its items are on: all, none or some. */
function group_mark(on, total) {
  return on === total ? tone.green('[✓]') : on ? tone.yellow('[−]') : tone.dim('[ ]');
}

/**
 * Optional settings as a folded tree, after the health-check menus: an overview first (→ to edit, enter to go on), then
 * groups that unfold into items. Arrows move, space toggles an item or a whole group, → unfolds, ← folds or returns to
 * the overview, enter confirms. Choices apply to this run only.
 * @param {string} message - the step title.
 * @param {{label: string, description: string, items: {label: string, hint: string, description: string, checked: boolean}[]}[]} groups
 * @returns {Promise<boolean[][]>} The checked state of every item, by group.
 */
export function tree_prompt(message, groups, input = process.stdin, output = process.stderr) {
  const checked = groups.map(group => group.items.map(item => Boolean(item.checked)));
  const expanded = new Set();
  const total = checked.flat().length;
  const width = Math.max(...groups.flatMap(group => [text_width(group.label) + 2, ...group.items.map(item => text_width(item.label))]));
  let editing = false, cursor = 0, drawn = 0;
  const count = index => checked[index].filter(Boolean).length;
  const enabled = () => checked.flat().filter(Boolean).length;
  const rows = () => groups.flatMap((group, index) => [{ group: index },
    ...(expanded.has(index) ? group.items.map((_, item) => ({ group: index, item })) : [])]);
  const draw = lines => {
    if (drawn) output.write(`\x1b[${drawn}A`);
    output.write(`${lines.map(line => `\x1b[2K${line}`).join('\n')}\n`);
    if (lines.length < drawn) output.write('\x1b[J');
    drawn = lines.length;
  };
  const row_text = ({ group, item }, focused) => {
    const pointer = focused ? tone.cyan('›') : ' ';
    if (item === undefined) {
      const arrow = expanded.has(group) ? '▾' : '▸';
      const label = pad(groups[group].label, width - 2);
      return `${bar()} ${pointer} ${arrow} ${group_mark(count(group), checked[group].length)} ${focused ? tone.bold(label) : label}  ${tone.dim(`${count(group)} / ${checked[group].length}`)}`;
    }
    const value = groups[group].items[item];
    const box = checked[group][item] ? tone.green('[✓]') : tone.dim('[ ]');
    return `${bar()} ${pointer}     ${box} ${focused ? tone.bold(pad(value.label, width)) : pad(value.label, width)}  ${tone.dim(value.hint)}`;
  };
  const overview = () => [`${tone.cyan('◆')}  ${message}`, bar(),
    ...groups.map((group, index) => `${bar()}  ${pad(group.label, width)}  ${tone.dim(`${count(index)} / ${checked[index].length}`)}`),
    bar(), `${bar()}  ${tone.dim('▸ 修改安装配置（→ 展开）')}`, `${tone.gray('└')}  ${tone.dim('回车 继续 · Ctrl+C 退出')}`];
  const editor = () => {
    const list = rows(), focus = list[cursor];
    const detail = focus.item === undefined ? groups[focus.group].description : groups[focus.group].items[focus.item].description;
    return [`${tone.cyan('◆')}  ${message}`, bar(), ...list.map((row, index) => row_text(row, index === cursor)), bar(),
      `${bar()}  ${tone.dim(detail)}`, `${bar()}  ${tone.cyan(`${enabled()} / ${total} 项启用 · 仅本次生效`)}`, bar(),
      `${bar()}  ${tone.dim('↑↓ 移动 · 空格 开关 · → 展开 · ← 收起 / 返回概览')}`, `${tone.gray('└')}  ${tone.dim('回车 继续 · Ctrl+C 退出')}`];
  };
  return new Promise((done, fail) => {
    const finish = error => {
      input.off('keypress', on_key);
      input.setRawMode(false);
      input.pause();
      const summary = groups.map((group, index) => `${group.label}：${group.items.filter((_, item) => checked[index][item]).map(item => item.label).join('、') || '不安装'}`);
      draw(error ? [`${tone.red('■')}  ${message}`, `${bar()}  ${tone.dim('已取消')}`]
        : [`${tone.green('◇')}  ${message}`, ...summary.map(line => `${bar()}  ${tone.dim(line)}`), bar()]);
      output.write('\x1b[?25h');
      if (error) fail(error); else done(checked);
    };
    const on_key = (_text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('已取消安装配置'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (!editing) {
        if (key.name === 'right') editing = true;
        return draw(editing ? editor() : overview());
      }
      const list = rows(), row = list[cursor];
      if (key.name === 'up' || key.name === 'down') cursor = (cursor + (key.name === 'down' ? 1 : list.length - 1)) % list.length;
      else if (key.name === 'space') {
        if (row.item === undefined) checked[row.group].fill(!checked[row.group].every(Boolean));
        else checked[row.group][row.item] = !checked[row.group][row.item];
      } else if (key.name === 'right') expanded.add(row.group);
      else if (key.name === 'left') {
        if (row.item === undefined && !expanded.has(row.group)) editing = false;
        else { expanded.delete(row.group); cursor = rows().findIndex(item => item.group === row.group && item.item === undefined); }
      }
      draw(editing ? editor() : overview());
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', on_key);
    output.write('\x1b[?25l');
    draw(overview());
  });
}

/** Close the gutter with a titled block of aligned rows, notes and a final line. */
export function outro(title, rows, notes, closing, mark = tone.green('◆')) {
  const width = Math.max(0, ...rows.map(([label]) => text_width(label)));
  const body = [...rows.map(([label, value, detail]) => [`${tone.dim(pad(label, width))}  ${value}`,
    ...(detail ? [`${' '.repeat(width)}  ${tone.dim(detail)}`] : [])]).flat(), ...(notes.length ? ['', ...notes] : [])];
  write(`${mark}  ${tone.bold(title)}\n${bar()}\n${body.map(line => `${bar()}  ${line}\n`).join('')}${bar()}\n${tone.gray('└')}  ${closing}\n\n`);
}
