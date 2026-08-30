import MarkdownIt from 'markdown-it';

// Keep the authored Markdown intact, changing only parsed link destinations.
// The pinned parser provides the same link/reference semantics used by checks;
// code fences, indented code, inline code and reference definitions are retained.
export function normalizeMarkdownLinks(body, resolveHref) {
  const parser = new MarkdownIt({ html: false });
  const env = { protectedLines: [] };
  const reference = parser.block.ruler.__rules__.find((rule) => rule.name === 'reference');
  const referenceRule = reference.fn;
  parser.block.ruler.at('reference', (state, start, end, silent) => {
    const matched = referenceRule(state, start, end, silent);
    if (matched && !silent) env.protectedLines.push([start, state.line]);
    return matched;
  }, { alt: reference.alt });

  for (const name of ['link', 'image']) {
    const original = parser.inline.ruler.__rules__.find((rule) => rule.name === name).fn;
    parser.inline.ruler.at(name, (state, silent) => {
      const start = state.pos;
      const source = state.src;
      const firstToken = state.tokens.length;
      const capture = !silent && env.captureSource === source;
      const matched = original(state, silent);
      if (!capture || !matched) return matched;
      const end = state.pos;
      const token = state.tokens.slice(firstToken).find((item) => item.type === (name === 'link' ? 'link_open' : 'image'));
      const href = token?.attrGet(name === 'link' ? 'href' : 'src');
      if (href == null) return matched;
      const resolved = resolveHref(href);
      if (resolved === href) return matched;
      const labelEnd = state.md.helpers.parseLinkLabel(state, start + (name === 'image' ? 1 : 0), name === 'link');
      if (labelEnd < 0) throw new Error('Unable to locate parsed Markdown link label');
      const title = token.attrGet('title');
      env.patches.push({ start: labelEnd + 1, end, text: '(<'+ resolved + '>' + (title ? ' ' + JSON.stringify(title) : '') + ')' });
      return matched;
    });
  }

  const tokens = parser.parse(body, env);
  const offsets = [0];
  for (const line of body.split('\n')) offsets.push(offsets.at(-1) + line.length + 1);
  const ranges = [...env.protectedLines, ...tokens.filter((token) => ['fence', 'code_block'].includes(token.type)).map((token) => token.map)]
    .map(([start, end]) => [offsets[start], Math.min(offsets[end], body.length)])
    .sort((a, b) => a[0] - b[0]);
  const normalizeInline = (text) => {
    env.captureSource = text;
    env.patches = [];
    parser.inline.parse(text, parser, env, []);
    let result = text;
    for (const patch of env.patches.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
    }
    env.captureSource = null;
    return result;
  };
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start > cursor) result += normalizeInline(body.slice(cursor, start));
    result += body.slice(Math.max(cursor, start), end);
    cursor = end;
  }
  return result + normalizeInline(body.slice(cursor));
}
