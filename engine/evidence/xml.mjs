// A small XML reader: enough for POMs, web.xml and Spring XML — elements, attributes, text, comments, CDATA.
// No DTDs, no namespaces beyond keeping the prefix in the tag name. A build file is data, not code: this is the only
// parsing the evidence layer does itself.
import assert from 'node:assert';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e] ?? m),
  );

// The first '>' that is not inside an attribute value.
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function attrsOf(body) {
  const attrs = {};
  for (const m of body.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decode(m[3] ?? m[4] ?? '');
  return attrs;
}

export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const add = (s) => {
    if (s) stack[stack.length - 1].text += decode(s);
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      add(text.slice(i));
      break;
    }
    add(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      add(text.slice(lt + 9, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const end = tagEnd(text, lt + 1);
    if (end < 0) break;
    const raw = text.slice(lt + 1, end).trim();
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1).trim() : raw;
      const name = /^[^\s]+/.exec(body)?.[0] ?? '';
      const node = { tag: name, attrs: attrsOf(body.slice(name.length)), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    i = end + 1;
  }
  return root;
}

export const childOf = (node, tag) => node?.children.find((c) => c.tag === tag) ?? null;
export const childrenOf = (node, tag) => (node?.children ?? []).filter((c) => tag === undefined || c.tag === tag);
// Text of an element and of its descendants: POM values are plain text, but nested markup should not be lost.
export const textOf = (node) =>
  node ? decode(`${node.text}${node.children.map((c) => textOf(c)).join('')}`).trim() : '';

{
  const doc = parseXml(
    '<?xml version="1.0"?><project a="1" b=\'x>y\'><!-- c --><name>N &amp; M</name><deps><d>one</d><d>two</d></deps><empty/></project>',
  );
  const project = childOf(doc, 'project');
  assert.deepStrictEqual(project.attrs, { a: '1', b: 'x>y' });
  assert.equal(textOf(childOf(project, 'name')), 'N & M');
  assert.deepStrictEqual(childrenOf(childOf(project, 'deps'), 'd').map(textOf), ['one', 'two']);
  assert.deepStrictEqual(childOf(project, 'empty').children, []);
  assert.equal(textOf(parseXml('<x><![CDATA[a<b]]></x>').children[0]), 'a<b');
}
